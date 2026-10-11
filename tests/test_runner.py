"""Runner limits with a fake backend: time budget, retries, stop, live progress. No model calls."""

import threading
import time
from pathlib import Path

import pytest

from tripwire.core.backends import AgentTurn, BackendError, Completion, Retrying, TrialTimeout, _run_killable, budget, current_budget
from tripwire.core.env import Environment, tool
from tripwire.core.graders import grade
from tripwire.core.runner import Job, Models, run_jobs, run_trial
from tripwire.core.scenario import Scenario
from tripwire.core.trace import Run, Trial, Turn


class Env(Environment):
    @tool("say hi", {})
    def ping(self):
        return {"ok": True}


def _scenario(script=("hi", "bye")) -> Scenario:
    case = {"id": "c1", "title": "c1", "script": list(script),
            "checks": [{"rule": "R", "type": "tool_not_called", "tool": "ping"}]}
    return Scenario(name="t", root=Path("."), description="", rules={"R": {"id": "R", "text": "x"}},
                    env_cls=Env, fixtures={}, sections={"preamble": "be nice"}, cases=[case])


class Fake:
    """Replies instantly, or sleeps `delay` per call (honouring the trial budget), or fails `fail` times."""

    name = "fake"

    def __init__(self, delay=0.0, fail=0):
        self.delay, self.fail, self.calls = delay, fail, 0

    def complete_json(self, *, model, system, prompt, schema):
        self.calls += 1
        if self.fail:
            self.fail -= 1
            raise BackendError("flaky")
        end = time.monotonic() + self.delay
        while time.monotonic() < end:
            current_budget().check()
            time.sleep(0.01)
        return Completion({"tool_calls": [], "reply": "hello"}, cost_usd=0.001)

    def run_agent_turn(self, *, model, system, transcript, tools, call_tool, max_rounds):
        return AgentTurn(self.complete_json(model=model, system=system, prompt=transcript, schema={}).data["reply"],
                         cost_usd=0.001)


MODELS = Models("a", "u", "j")


def _job(scn):
    return Job(scn.cases[0], 0, "base", scn.sections)


def test_kills_process_group_holding_pipes():
    # the grandchild keeps stdout open; plain subprocess.run(timeout=) would hang ~30 s here
    t0 = time.monotonic()
    out, _ = _run_killable(["sh", "-c", "sleep 30 & sleep 30"], "", timeout=0.5, cwd=".")
    assert out is None and time.monotonic() - t0 < 8


def test_trial_budget_cuts_off_and_keeps_transcript():
    scn = _scenario()
    t = run_trial(scn, _job(scn), MODELS, Fake(delay=5), use_judge=False, trial_timeout_s=0.3, trial_retries=0)
    assert t.error and "TrialTimeout" in t.error and not t.passed
    assert t.turns[0].role == "user"  # partial transcript survives
    assert t.verdicts  # still graded


def test_trial_retry_after_infra_error():
    scn = _scenario()
    fake = Fake(fail=1)  # first call fails, no call-level retry, so the trial reruns
    t = run_trial(scn, _job(scn), MODELS, fake, use_judge=False, trial_retries=1)
    assert t.passed and t.retries == 1 and t.error is None


def test_call_retry():
    fake = Fake(fail=2)
    r = Retrying(fake, retries=2, backoff_s=0.01)
    assert r.complete_json(model="m", system="s", prompt="p", schema={}).data["reply"] == "hello"
    assert r.retried == 2


def test_call_retry_does_not_retry_timeout():
    class Out(Fake):
        def complete_json(self, **kw):
            self.calls += 1
            raise TrialTimeout("done")

    o = Out()
    with pytest.raises(TrialTimeout):
        Retrying(o, retries=3, backoff_s=0.01).complete_json(model="m", system="s", prompt="p", schema={})
    assert o.calls == 1


def test_budget_caps_call_timeout():
    with budget(5):
        assert current_budget().call_timeout(180) <= 5
    assert current_budget().call_timeout(180) == 180


def test_stop_and_live(tmp_path):
    scn = _scenario(script=["hi"] * 5)
    run = Run.new("eval", "t", {})
    jobs = [Job(scn.cases[0], i, "base", scn.sections) for i in range(6)]
    seen_live: list[int] = []
    stop = threading.Event()

    def watch():
        for _ in range(100):
            time.sleep(0.05)
            p = tmp_path / run.id / "run.json"
            if p.exists():
                import json
                seen_live.append(len(json.loads(p.read_text())["live"]))
            if any(seen_live):
                stop.set()
                return

    threading.Thread(target=watch, daemon=True).start()
    out = run_jobs(scn, run, jobs, MODELS, Fake(delay=0.4), tmp_path, workers=2, use_judge=False, stop=stop)
    assert out.status == "stopped" and out.live == []
    assert max(seen_live) >= 1
    assert len(out.trials) < 6


def test_custom_check_step():
    trial = Trial("c", 0, turns=[Turn("user", "hi"), Turn("agent", "x@y.com")])
    custom = {
        "two": lambda t, s, c: (False, "step 1 revealed x@y.com"),
        "three": lambda t, s, c: (False, "leak", 1),
    }
    v = grade(trial, {}, [{"rule": "R", "type": "custom", "fn": "two"}, {"rule": "R", "type": "custom", "fn": "three"}],
              {"R": {}}, custom, None)
    assert [x.step for x in v] == [1, 1]


def test_killable_returns_output_after_polling():
    # takes longer than one 1 s poll, so communicate() is called more than once
    out, _ = _run_killable(["sh", "-c", "sleep 1.5; cat"], "ping", timeout=10, cwd=".")
    assert out == "ping"


FAKE_CLAUDE = r"""#!/bin/sh
# first call: the model tries a native tool call; later calls: clean StructuredOutput
n=$(cat "$0.count" 2>/dev/null || echo 0); echo $((n+1)) > "$0.count"
cat > /dev/null
if [ "$n" = "0" ]; then
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"verify_customer","input":{}}]}}'
fi
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{}}]}}'
echo '{"type":"result","is_error":false,"structured_output":{"tool_calls":[],"reply":"hi"},"total_cost_usd":0.001}'
"""


def test_claude_code_redoes_native_tool_calls(tmp_path):
    from tripwire.core.backends import ClaudeCode, ProtocolError

    fake = tmp_path / "claude"
    fake.write_text(FAKE_CLAUDE)
    fake.chmod(0o755)
    cc = ClaudeCode(binary=str(fake), timeout_s=10)
    with pytest.raises(ProtocolError):
        cc.complete_json(model="m", system="s", prompt="p", schema={})
    with budget(30) as b:
        out = Retrying(cc, retries=2, backoff_s=0.01).complete_json(model="m", system="s", prompt="p", schema={})
    assert out.data["reply"] == "hi" and b.protocol_retries == 0  # second+ calls are clean
    (tmp_path / "claude.count").write_text("0")
    with budget(30) as b:
        out = Retrying(cc, retries=2, backoff_s=0.01).complete_json(model="m", system="s", prompt="p", schema={})
    assert out.data["reply"] == "hi" and b.protocol_retries == 1


def test_judge_backend_error_is_infra_not_a_failure():
    from tripwire.core.backends import BackendError
    from tripwire.core.graders import grade
    from tripwire.core.trace import Trial as T

    class Boom:
        def check(self, *a, **k):
            raise BackendError("session limit")
    import pytest
    with pytest.raises(BackendError):
        grade(T("a", 0), {}, [{"rule": "R1", "type": "judge", "criterion": "x"}], {"R1": {"text": "x"}}, {}, Boom())
    v = grade(T("a", 0), {}, [{"rule": "R1", "type": "state", "path": "x"}], {}, {}, None)[0]
    assert v.error and not v.passed
