"""Native tools: a fake `claude` binary that launches the real MCP bridge from --mcp-config and
drives tools/list + tools/call end to end. No model calls."""

import json
import sys
import time
from types import SimpleNamespace

import pytest

from tripwire.core.agent import PromptAgent, render_transcript
from tripwire.core.backends import (Anthropic, BackendError, ClaudeCode, ProtocolError, Retrying, ToolsAlreadyRan,
                                    TrialTimeout, budget, current_budget)
from tripwire.core.env import Environment, tool
from tripwire.core.trace import ToolCall, Turn

# Behaviour comes from <binary>.plan (JSON list, one entry per invocation; the last one repeats):
#   {"calls": [[name, args], ...], "foreign": name|null, "extra": [names], "reply": str,
#    "max_turns": bool, "hang": bool}
FAKE = r'''#!PYTHON
import json, os, subprocess, sys, time
me = sys.argv[0]
argv = sys.argv[1:]
arg = lambda f: argv[argv.index(f) + 1] if f in argv else None
n = int(open(me + ".count").read()) if os.path.exists(me + ".count") else 0
open(me + ".count", "w").write(str(n + 1))
plans = json.load(open(me + ".plan"))
plan = plans[min(n, len(plans) - 1)]
prompt = sys.stdin.read()
open(me + ".argv", "w").write(json.dumps({"argv": argv, "prompt": prompt, "env": {k: os.environ.get(k) for k in ("ENABLE_TOOL_SEARCH", "MCP_TIMEOUT")}}))
srv = json.loads(arg("--mcp-config"))["mcpServers"]["tw"]
p = subprocess.Popen([srv["command"], *srv["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
rid = 0
def rpc(method, params=None):
    global rid
    rid += 1
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n")
    p.stdin.flush()
    return json.loads(p.stdout.readline())
out = lambda e: print(json.dumps(e), flush=True)
assert rpc("initialize", {"protocolVersion": "2025-06-18"})["result"]["capabilities"]["tools"] is not None
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); p.stdin.flush()
tools = rpc("tools/list")["result"]["tools"]
out({"type": "system", "subtype": "init", "tools": ["mcp__tw__" + t["name"] for t in tools]})
if plan.get("hang"):
    time.sleep(60)
for name, args in plan.get("calls", []):
    out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t", "name": "mcp__tw__" + name, "input": args}]}})
    r = rpc("tools/call", {"name": name, "arguments": args})["result"]
    out({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t", "content": r["content"], "is_error": r["isError"]}]}})
for name in [plan.get("foreign")] + plan.get("extra", []):
    if name:
        out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "f", "name": name, "input": {}}]}})
if plan.get("max_turns"):
    out({"type": "result", "subtype": "error_max_turns", "is_error": True, "total_cost_usd": 0.002})
else:
    reply = plan.get("reply", "done") + " | tools=" + ",".join(t["name"] for t in tools)
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}})
    out({"type": "result", "subtype": "success", "is_error": False, "result": reply, "total_cost_usd": 0.003, "duration_ms": 10})
'''


class Env(Environment):
    @tool("look up a customer", {"email": {"type": "string"}})
    def get_customer(self, email):
        return {"id": "c1", "email": email}

    @tool("refund a charge", {"amount": {"type": "number"}})
    def refund(self, amount):
        if amount > 75:
            return {"ok": False, "error": "over limit"}
        self.state.setdefault("refunds", []).append(amount)
        return {"ok": True}


@pytest.fixture
def fake(tmp_path):
    path = tmp_path / "claude"
    path.write_text(FAKE.replace("PYTHON", sys.executable))
    path.chmod(0o755)

    def make(*plans):
        (tmp_path / "claude.plan").write_text(json.dumps(list(plans)))
        (tmp_path / "claude.count").write_text("0")
        return ClaudeCode(binary=str(path), timeout_s=20)

    make.seen = lambda: json.loads((tmp_path / "claude.argv").read_text())
    make.count = lambda: int((tmp_path / "claude.count").read_text())
    return make


def _agent(backend):
    return PromptAgent({"preamble": "be nice"}, "m", backend)


def test_end_to_end_tools_via_mcp_bridge(fake):
    cc = fake({"calls": [["get_customer", {"email": "a@b.c"}], ["refund", {"amount": 100}], ["refund", {"amount": 20}]],
               "reply": "Refunded $20."})
    env, live = Env({}), []
    with budget(30):
        turns = _agent(cc).respond(env, [Turn("user", "refund please")], lambda: 0.0, on_turn=live.append)
    assert [t.role for t in turns] == ["tool", "tool", "tool", "agent"]
    assert [t.tool_call.name for t in turns[:3]] == ["get_customer", "refund", "refund"]  # prefix stripped
    assert turns[0].tool_call.result == {"id": "c1", "email": "a@b.c"}
    assert [t.tool_call.blocked for t in turns[:3]] == [False, True, False]
    assert env.state["refunds"] == [20]
    assert turns[3].text == "Refunded $20. | tools=get_customer,refund"  # tools/list went through the bridge
    assert live == turns  # streamed as they happened
    seen = fake.seen()
    argv = seen["argv"]
    assert argv[argv.index("--max-turns") + 1] == "9" and argv[argv.index("--allowedTools") + 1] == "mcp__tw__*"
    assert seen["env"] == {"ENABLE_TOOL_SEARCH": "false", "MCP_TIMEOUT": "30000"}
    assert "Customer: refund please" in seen["prompt"]


def test_tool_handler_runs_in_trial_context(fake):
    cc = fake({"calls": [["get_customer", {"email": "x"}]]})
    seen = []

    def call_tool(name, args):
        seen.append(current_budget())
        return {"ok": True}, False

    with budget(30) as b:
        out = cc.run_agent_turn(model="m", system="s", transcript="t", tools=Env.tool_specs(),
                                call_tool=call_tool, max_rounds=8)
    assert seen == [b] and out.calls[0].name == "get_customer" and out.cost_usd == 0.003


def test_foreign_tool_is_protocol_error_and_redone(fake):
    cc = fake({"foreign": "verify_customer"}, {"reply": "ok"})
    with budget(30) as b:
        out = Retrying(cc, retries=0).run_agent_turn(model="m", system="s", transcript="t", tools=Env.tool_specs(),
                                                     call_tool=Env({}).call, max_rounds=8)
    assert out.reply.startswith("ok") and b.protocol_retries == 1 and fake.count() == 2


def test_foreign_tool_without_retrying_raises(fake):
    cc = fake({"foreign": "Bash"})
    with budget(30), pytest.raises(ProtocolError):
        cc.run_agent_turn(model="m", system="s", transcript="t", tools=[], call_tool=Env({}).call, max_rounds=8)


def test_no_redo_once_a_tool_ran(fake):
    cc = fake({"calls": [["refund", {"amount": 10}]], "foreign": "verify_customer"}, {"reply": "ok"})
    env = Env({})
    with budget(30), pytest.raises(ToolsAlreadyRan):
        Retrying(cc, retries=2, backoff_s=0.01).run_agent_turn(
            model="m", system="s", transcript="t", tools=Env.tool_specs(), call_tool=env.call, max_rounds=8)
    assert env.state["refunds"] == [10] and fake.count() == 1  # the refund ran once, never twice


def test_harmless_builtin_is_recorded_not_fatal(fake):
    cc = fake({"extra": ["EndConversation"], "reply": "bye"})
    with budget(30):
        out = cc.run_agent_turn(model="m", system="s", transcript="t", tools=[], call_tool=Env({}).call, max_rounds=8)
    assert out.reply.startswith("bye") and out.ignored == ["EndConversation"]


def test_max_turns_gives_empty_reply(fake):
    cc = fake({"calls": [["get_customer", {"email": "x"}]], "max_turns": True})
    with budget(30):
        out = cc.run_agent_turn(model="m", system="s", transcript="t", tools=Env.tool_specs(),
                                call_tool=Env({}).call, max_rounds=8)
    assert out.reply == "" and len(out.calls) == 1


def test_hung_claude_and_bridge_are_killed(fake):
    cc = fake({"hang": True})
    t0 = time.monotonic()
    with budget(1.5), pytest.raises((TrialTimeout, BackendError)):
        cc.run_agent_turn(model="m", system="s", transcript="t", tools=[], call_tool=Env({}).call, max_rounds=8)
    assert time.monotonic() - t0 < 8


def test_tool_handler_exception_is_reraised(fake):
    cc = fake({"calls": [["get_customer", {"email": "x"}]]})

    def boom(name, args):
        raise TrialTimeout("budget gone")

    with budget(30), pytest.raises(TrialTimeout):
        cc.run_agent_turn(model="m", system="s", transcript="t", tools=Env.tool_specs(), call_tool=boom, max_rounds=8)


def test_transcript_is_plain_text():
    text = render_transcript([Turn("user", "hi"), Turn("tool", tool_call=ToolCall("get_customer", {"email": "a"}, {"id": 1})),
                              Turn("agent", "hello")])
    assert "Customer: hi" in text and "You: hello" in text
    assert "get_customer tool with email = \"a\"" in text and "get_customer(" not in text


def _block(**kw):
    return SimpleNamespace(**kw)


def test_anthropic_native_tool_loop():
    responses = [
        SimpleNamespace(stop_reason="tool_use", content=[
            _block(type="text", text="checking"),
            _block(type="tool_use", id="u1", name="get_customer", input={"email": "a"}),
            _block(type="tool_use", id="u2", name="refund", input={"amount": 500})]),
        SimpleNamespace(stop_reason="end_turn", content=[_block(type="text", text="Can't refund that much.")]),
    ]
    sent = []

    class Messages:
        def create(self, **kw):
            sent.append(json.loads(json.dumps(kw["messages"], default=lambda o: vars(o))))
            return responses[len(sent) - 1]

    env = Env({})
    a = Anthropic(client=SimpleNamespace(messages=Messages()))
    out = a.run_agent_turn(model="m", system="s", transcript="t", tools=Env.tool_specs(), call_tool=env.call, max_rounds=8)
    assert out.reply == "Can't refund that much."
    assert [(c.name, c.blocked) for c in out.calls] == [("get_customer", False), ("refund", True)]
    results = sent[1][-1]["content"]
    assert [r["tool_use_id"] for r in results] == ["u1", "u2"] and results[1]["is_error"] is True
