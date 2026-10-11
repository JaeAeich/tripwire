"""Core pieces that need no model: sections, diff, path resolve, graders, summaries."""

from tripwire.core.agent import parse_sections, render_sections
from tripwire.core.env import diff, resolve
from tripwire.core.graders import grade
from tripwire.core.trace import Run, ToolCall, Trial, Turn
from tripwire.eval import summarize


def test_sections_roundtrip():
    md = "intro\n\n## A\none\n\n## B\ntwo"
    s = parse_sections(md)
    assert list(s) == ["preamble", "A", "B"]
    assert parse_sections(render_sections(s)) == s


def test_diff_and_resolve():
    a = {"t": [{"id": "x", "s": "settled"}], "n": 1}
    b = {"t": [{"id": "x", "s": "refunded"}], "n": 1}
    assert diff(a, b) == [{"path": "t[id=x].s", "op": "change", "before": "settled", "after": "refunded"}]
    assert resolve(b, "t[id=x].s") == "refunded"


def _trial():
    return Trial("c", 0, turns=[
        Turn("user", "hi"),
        Turn("tool", tool_call=ToolCall("issue_refund", {"txn_id": "t1"}, {"ok": False}, True)),
        Turn("agent", "Sure, refunded!"),
    ])


def test_graders():
    rules = {"R": {"id": "R", "text": "x"}}
    v = grade(_trial(), {"x": 1}, [
        {"rule": "R", "type": "tool_not_called", "tool": "issue_refund"},
        {"rule": "R", "type": "text_not_matches", "pattern": "refunded"},
        {"rule": "R", "type": "state", "path": "x", "equals": 1},
    ], rules, {}, None)
    assert [x.passed for x in v] == [False, False, True]
    assert v[0].step == 1 and v[1].step == 2


def test_summary_pass_hat_k():
    run = Run.new("eval", "s", {"k": 2})
    for cid, passes in {"a": [True, True], "b": [True, False]}.items():
        for i, p in enumerate(passes):
            run.trials.append(Trial(cid, i, passed=p))
    s = summarize(run)
    assert s["pass_at_1"] == 0.75 and s["pass_hat_k"] == 0.5
