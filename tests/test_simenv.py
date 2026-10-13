"""SimulatedEnv with a fake backend: arg checks, consistency, state changes, threads. No model calls."""

import contextvars
import json
import threading

import pytest

from tripwire.core.backends import Completion
from tripwire.core.simenv import SimulatedEnv, apply_change, make_env_cls, validate_args

TOOLS = [
    {"name": "get_order", "description": "Look up an order", "mutates": False,
     "input_schema": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}},
    {"name": "cancel_order", "description": "Cancel an order", "mutates": True,
     "input_schema": {"type": "object", "properties": {"order_id": {"type": "string"},
                                                       "notify": {"type": "boolean"}},
                      "required": ["order_id"], "additionalProperties": False}},
    {"name": "create_ticket", "description": "Open a ticket", "mutates": True,
     "input_schema": {"type": "object", "properties": {"summary": {"type": "string"},
                                                       "priority": {"type": "string", "enum": ["low", "high"]}},
                      "required": ["summary"]}},
]
FIXTURES = {"orders": [{"id": "o_1", "status": "shipped", "total": 40}]}


class FakeSim:
    """Plays the backend from the state embedded in the prompt, like the real simulator would."""

    name = "fake"

    def __init__(self):
        self.calls = 0
        self.prompts = []

    def complete_json(self, *, model, system, prompt, schema):
        self.calls += 1
        self.prompts.append(prompt)
        state = json.loads(prompt.split("# Current state (JSON)\n")[1].split("\n\n# Earlier calls")[0])
        call = prompt.split("# This call\n")[1].split("\n")[0]
        name, args = call.split(" ", 1)
        args = json.loads(args)
        if name == "get_order":
            o = next((o for o in state["orders"] if o["id"] == args["order_id"]), None)
            res, ok, changes = (o, True, []) if o else ({"error": "not_found"}, False, [])
        elif name == "cancel_order":
            res, ok = {"ok": True}, True
            changes = [{"op": "set", "path": f"orders[id={args['order_id']}].status", "value_json": '"cancelled"'}]
        else:
            tid = f"tk_{len(state.get('tickets', [])) + 1}"
            res, ok = {"ticket_id": tid}, True
            changes = [{"op": "append", "path": "tickets", "value_json": json.dumps({"id": tid, **args})}]
        return Completion({"ok": ok, "result_json": json.dumps(res), "changes": changes}, cost_usd=0.001)


def _env():
    fake = FakeSim()
    return SimulatedEnv(FIXTURES, tools=TOOLS, world="A shop.", backend=fake), fake


def test_bad_args_are_rejected_without_a_model_call():
    env, fake = _env()
    assert env.call("get_order", {})[1] is True
    assert "missing order_id" in env.call("get_order", {})[0]["error"]
    assert "unknown argument" in env.call("cancel_order", {"order_id": "o_1", "why": "x"})[0]["error"]
    assert "should be boolean" in env.call("cancel_order", {"order_id": "o_1", "notify": "yes"})[0]["error"]
    assert "one of" in env.call("create_ticket", {"summary": "x", "priority": "urgent"})[0]["error"]
    assert env.call("nope", {})[0]["error"] == "unknown tool nope"
    assert fake.calls == 0 and env.cost_usd == 0


def test_same_lookup_same_answer_and_cached():
    env, fake = _env()
    a, blocked = env.call("get_order", {"order_id": "o_1"})
    b, _ = env.call("get_order", {"order_id": "o_1"})
    assert a == b and not blocked and fake.calls == 1
    assert env.log[1].get("cached") is True
    missing, blocked = env.call("get_order", {"order_id": "o_9"})
    assert blocked and missing == {"error": "not_found"}
    assert env.cost_usd == pytest.approx(0.002)


def test_changes_persist_and_invalidate_cache():
    env, fake = _env()
    env.call("get_order", {"order_id": "o_1"})
    _, blocked = env.call("cancel_order", {"order_id": "o_1"})
    assert not blocked and env.state["orders"][0]["status"] == "cancelled"
    after, _ = env.call("get_order", {"order_id": "o_1"})
    assert after["status"] == "cancelled" and fake.calls == 3  # cache cleared by the change
    env.call("create_ticket", {"summary": "help"})
    env.call("create_ticket", {"summary": "again"})  # mutating calls are never cached
    assert [t["id"] for t in env.state["tickets"]] == ["tk_1", "tk_2"]
    assert '"tk_1"' in fake.prompts[-1]  # the simulator sees the created record and the call log
    assert FIXTURES["orders"][0]["status"] == "shipped"  # fixtures untouched


def test_bad_change_paths_are_recorded_not_raised():
    class Bad(FakeSim):
        def complete_json(self, **kw):
            return Completion({"ok": True, "result_json": "not json", "changes": [
                {"op": "set", "path": "orders[id=zz].status", "value_json": '"x"'}]})
    env = SimulatedEnv(FIXTURES, tools=TOOLS, backend=Bad())
    res, blocked = env.call("cancel_order", {"order_id": "o_1"})
    assert res == "not json" and not blocked and env.errors


def test_apply_change_paths():
    s = {"orders": [{"id": "o_1", "status": "a"}]}
    apply_change(s, "set", "orders[id=o_1].status", "b")
    apply_change(s, "append", "refunds", {"id": "r_1"})
    apply_change(s, "set", "orders[id=o_2]", {"id": "o_2"})
    apply_change(s, "set", "session.verified", True)
    apply_change(s, "remove", "orders[id=o_1]", None)
    assert s == {"orders": [{"id": "o_2"}], "refunds": [{"id": "r_1"}], "session": {"verified": True}}


def test_validate_args_types():
    schema = {"type": "object", "properties": {"n": {"type": "integer"}, "x": {"type": ["number", "null"]}}}
    assert validate_args(schema, {"n": 3, "x": None}) is None
    assert validate_args(schema, {"n": 3.0, "x": 1.5}) is None
    assert validate_args(schema, {"n": True}) is not None
    assert validate_args(schema, {"n": "3"}) is not None


def test_env_cls_for_runner():
    cls = make_env_cls("shop", TOOLS, "A shop.", "m")
    specs = cls.tool_specs()
    assert [t["name"] for t in specs] == ["get_order", "cancel_order", "create_ticket"]
    assert all(set(t) == {"name", "description", "input_schema"} for t in specs)
    fake = FakeSim()
    cls.backend = fake
    env = cls(FIXTURES)
    env.call("get_order", {"order_id": "o_1"})
    assert fake.calls == 1 and env.model == "m"


def test_called_from_another_thread_in_trial_context():
    env, fake = _env()
    ctx = contextvars.copy_context()
    out = {}
    t = threading.Thread(target=lambda: out.update(r=ctx.run(env.call, "get_order", {"order_id": "o_1"})))
    t.start()
    t.join()
    assert out["r"][0]["id"] == "o_1"
