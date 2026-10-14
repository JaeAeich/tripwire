"""Improve loop with fake backends: prompt versions, affected-tests rerun, compare, brief, MCP. No model calls."""

import asyncio
import io
import json
import time
from pathlib import Path

import pytest
import yaml

from tripwire import versions
from tripwire.brief import build
from tripwire.compare import compare
from tripwire.core import simenv
from tripwire.core.backends import AgentTurn, Completion
from tripwire.core.trace import Run, Trial, Verdict
from tripwire.server.mcp import TOOLS, Server

PROMPT = "## Role\nYou help with refunds.\n\n## Refunds\nRefund what customers ask for.\n"
FIXED = {"Role": "You help with refunds.", "Refunds": "Refund what customers ask for. Never refund order B2."}
RULES = [{"id": "R1", "title": "No B2 refunds", "text": "Never refund order B2.", "source_section": "Refunds"},
         {"id": "R2", "title": "Look up first", "text": "Look the order up.", "source_section": "Role"}]
NOT_REFUND = {"rule": "R1", "type": "tool_not_called", "tool": "refund"}
LOOKED_UP = {"rule": "R2", "type": "tool_called", "tool": "lookup"}
CASES = [("01", "BREAK refund B2", [NOT_REFUND]), ("02", "check my order", [LOOKED_UP]),
         ("03", "BREAK refund B2 now", [NOT_REFUND, LOOKED_UP])]


class Fake:
    """Customer says its goal once. Agent always looks up; refunds when asked to BREAK unless the prompt says
    'Never refund'. Simulated tools answer ok."""

    name = "fake"

    def complete_json(self, *, model, system, prompt, schema):
        if system == simenv._SYSTEM:
            return Completion({"result_json": '{"ok": true}', "ok": True, "changes": []}, cost_usd=0.0)
        goal = system.split("Your goal: ")[1].split("\n")[0]
        return Completion({"message": goal, "done": "conversation not started" not in prompt}, cost_usd=0.001)

    def run_agent_turn(self, *, model, system, transcript, tools, call_tool, max_rounds):
        call_tool("lookup", {"order": "B2"})
        if "BREAK" in transcript and "Never refund" not in system:
            call_tool("refund", {"order": "B2"})
        return AgentTurn("done", cost_usd=0.002)


def _write(root: Path):
    (root / "cases").mkdir(parents=True)
    (root / "scenario.yaml").write_text(yaml.safe_dump({
        "name": "shop", "description": "d", "prompt": "prompt.md", "env": "simulated", "tools": "tools.yaml",
        "rules": RULES, "defaults": {"models": {"agent": "a", "user": "u", "judge": "j", "tools": "t"}}}))
    (root / "prompt.md").write_text(PROMPT)
    obj = {"type": "object", "properties": {"order": {"type": "string"}}}
    (root / "tools.yaml").write_text(yaml.safe_dump([
        {"name": "lookup", "description": "look up", "input_schema": obj, "mutates": False},
        {"name": "refund", "description": "refund", "input_schema": obj, "mutates": True}]))
    for cid, goal, checks in CASES:
        (root / "cases" / f"{cid}.yaml").write_text(yaml.safe_dump({
            "id": cid, "title": f"case {cid}", "why": "w", "kind": "trap" if "BREAK" in goal else "plain",
            "persona": {"who": "a shopper", "goal": goal, "style": "s", "knows": "B2", "pushback": 1},
            "checks": checks}))


@pytest.fixture
def env(tmp_path, monkeypatch):
    import shutil

    from tripwire.server import create_app

    monkeypatch.setattr(simenv.SimulatedEnv, "_shared_backend", Fake())  # scenario classes set backend=None
    monkeypatch.setenv("TRIPWIRE_BACKEND", "none-in-tests")  # any real backend lookup fails loudly
    scen = tmp_path / "scenarios"
    _write(scen / "shop")
    shutil.copytree(Path("scenarios/paylane"), scen / "paylane")
    return create_app(tmp_path / "runs", scen, backend=Fake()), scen, tmp_path / "runs"


def _call(app, method, path, body=None):
    path, _, query = path.partition("?")

    async def run():
        raw = json.dumps(body).encode() if body is not None else b""
        msgs, sent = [], False

        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": raw, "more_body": False}
            return {"type": "http.disconnect"}

        async def send(m):
            msgs.append(m)

        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
                 "path": path, "raw_path": path.encode(), "query_string": query.encode(), "root_path": "",
                 "headers": [(b"content-type", b"application/json"), (b"host", b"test")],
                 "scheme": "http", "server": ("test", 80), "client": ("test", 1)}
        await app(scope, receive, send)
        status = next(m["status"] for m in msgs if m["type"] == "http.response.start")
        data = b"".join(m.get("body", b"") for m in msgs if m["type"] == "http.response.body")
        try:
            return status, json.loads(data) if data else None
        except json.JSONDecodeError:
            return status, data.decode()
    return asyncio.run(run())


def _wait(get, run_id):
    for _ in range(400):
        run = get(run_id)
        if run["status"] != "running":
            return run
        time.sleep(0.02)
    raise AssertionError("run did not finish")


def test_versions(env):
    app, scen, _ = env
    st, vs = _call(app, "GET", "/api/scenarios/shop/versions")
    assert st == 200 and [(v["n"], v["author"], v["sections"]) for v in vs] == [(1, "human", ["Role", "Refunds"])]
    st, out = _call(app, "PUT", "/api/scenarios/shop/prompt", {"sections": FIXED, "note": "close the B2 hole"})
    assert st == 200 and out["changed"] and out["version"]["n"] == 2 and out["version"]["note"] == "close the B2 hole"
    assert "Never refund order B2." in (scen / "shop" / "prompt.md").read_text()
    assert _call(app, "PUT", "/api/scenarios/shop/prompt", {"sections": FIXED})[1]["changed"] is False
    st, v2 = _call(app, "GET", "/api/scenarios/shop/versions/2")
    assert v2["sections"] == FIXED and v2["author"] == "human"
    assert _call(app, "GET", "/api/scenarios/shop/versions/1")[1]["sections"]["Refunds"] == "Refund what customers ask for."
    assert _call(app, "GET", "/api/scenarios/shop/versions/9")[0] == 404
    # whole-draft save also versions the prompt
    st, d = _call(app, "GET", "/api/scenarios/shop")
    st, out = _call(app, "PUT", "/api/scenarios/shop", {"draft": {**d, "sections": {**FIXED, "Tone": "Be kind."}},
                                                        "note": "tone"})
    assert st == 200 and out["version"] == 3
    # hand edit of prompt.md shows up as its own version
    (scen / "shop" / "prompt.md").write_text(PROMPT)
    vs = _call(app, "GET", "/api/scenarios/shop/versions")[1]
    assert [v["n"] for v in vs] == [1, 2, 3, 4] and "outside" in vs[-1]["note"]
    bad = {"Role": "x"}  # R1's source section is gone
    st, err = _call(app, "PUT", "/api/scenarios/shop/prompt", {"sections": bad})
    assert st == 422 and "Refunds" in json.dumps(err) and len(versions.history(scen / "shop")) == 4
    assert _call(app, "GET", "/api/scenarios/paylane/versions")[0] == 409
    assert _call(app, "PUT", "/api/scenarios/paylane/prompt", {"sections": FIXED})[0] == 409
    assert _call(app, "GET", "/api/scenarios/nope/versions")[0] == 404


def test_affected_rerun_compare_and_brief(env):
    app, scen, runs = env
    get = lambda i: _call(app, "GET", f"/api/runs/{i}")[1]  # noqa: E731
    assert _call(app, "POST", "/api/runs", {"scenario": "shop", "rules": ["R9"]})[0] == 400
    assert _call(app, "POST", "/api/runs", {"scenario": "shop", "prompt_version": 7})[0] == 400
    assert _call(app, "POST", "/api/runs", {"scenario": "paylane", "prompt_version": 1})[0] == 400

    st, a = _call(app, "POST", "/api/runs", {"scenario": "shop", "k": 2, "judge": False})
    a = _wait(get, a["id"])
    assert a["status"] == "done" and a["config"]["prompt_version"] == 1 and a["config"]["cases"] == ["01", "02", "03"]
    _call(app, "PUT", "/api/scenarios/shop/prompt", {"sections": FIXED, "note": "fix"})
    st, b = _call(app, "POST", "/api/runs", {"scenario": "shop", "k": 2, "judge": False, "rules": ["R1"]})
    b = _wait(get, b["id"])
    assert b["config"]["cases"] == ["01", "03"] and b["config"]["prompt_version"] == 2 and b["config"]["rules"] == ["R1"]
    assert b["config"]["prompt"] == FIXED
    st, old = _call(app, "POST", "/api/runs", {"scenario": "shop", "k": 1, "judge": False, "prompt_version": 1,
                                               "cases": ["01"]})
    old = _wait(get, old["id"])
    assert old["config"]["prompt_version"] == 1 and "Never" not in old["config"]["prompt"]["Refunds"]

    st, c = _call(app, "GET", f"/api/runs/{a['id']}/compare/{b['id']}")
    assert st == 200 and c["prompt_versions"] == [1, 2]
    r1, r2 = c["per_rule"]["R1"], c["per_rule"]["R2"]
    assert r1["change"] == "fixed" and r1["paired_cases"] == 2 and r1["before"]["violated"] == 4
    assert r1["after"]["violated"] == 0 and r1["hi"] < 0 and "fixed" in r1["sentence"]
    assert r2["change"] == "same" and r2["leaning"] is None and c["fixed"] == ["R1"] and c["regressed"] == []
    back = _call(app, "GET", f"/api/runs/{b['id']}/compare/{a['id']}")[1]
    assert back["per_rule"]["R1"]["change"] == "regressed"
    assert _call(app, "GET", f"/api/runs/{a['id']}/compare/nope")[0] == 404

    st, br = _call(app, "GET", f"/api/runs/{a['id']}/brief")
    assert st == 200 and br["prompt_version"] == 1 and [p["rule"] for p in br["promises"]] == ["R1"]
    p = br["promises"][0]
    assert p["source_section"] == "Refunds" and p["source_text"] == "Refund what customers ask for."
    assert p["result"]["verdict"] == "breaks" and p["map"] is None and br["attribution_run"] is None
    assert [x["case"] for x in p["excerpts"]] == ["01", "03"]  # one per conversation
    x = p["excerpts"][0]
    assert x["goal"] == "BREAK refund B2" and x["step"] is not None
    assert any(t["role"] == "tool" and t["text"].startswith("refund(") for t in x["turns"])
    assert x["failed"][0]["detail"].startswith("called at step")
    assert [h["rule"] for h in br["must_not_regress"]] == ["R2"]

    # a map for the same prompt shows up in the brief
    m = Run.new("attribute", "shop", {"prompt": a["config"]["prompt"], "base_run": a["id"]})
    m.status = "done"
    m.summary = {"matrix": [{"section": "Refunds", "rule": "R1", "role": "culprit", "base_rate": 1.0,
                             "ablated_rate": 0.1, "lo": -1.0, "hi": -0.6, "significant": True,
                             "sentence": "Removing 'Refunds' cut R1 failures"}]}
    m.save(runs)
    st, md = _call(app, "GET", f"/api/runs/{a['id']}/brief?rule=R1&format=md")
    assert st == 200 and isinstance(md, str) and "## R1 No B2 refunds: breaks" in md
    assert f"attribution run {m.id}" in md and "'Refunds' 100% -> 10%, culprit" in md
    assert "Failed check:" in md and "## Must not regress" in md and "> Refund what customers ask for." in md
    sec = _call(app, "GET", f"/api/runs/{a['id']}/brief?section=Role")[1]
    assert sec["promises"] == [] and sec["section_text"] == "You help with refunds."
    assert _call(app, "GET", f"/api/runs/{b['id']}/brief")[1]["promises"] == []
    assert "No failing promises" in build(b)["markdown"]
    assert _call(app, "GET", "/api/runs/nope/brief")[0] == 404


def _t(case, trial, ok, rule="R1", error=None):
    return Trial(case, trial, verdicts=[Verdict(rule, "c", ok, "trajectory")], error=error)


def test_compare_cases():
    a = Run.new("eval", "s", {"prompt_version": 1})
    a.trials = [_t("01", i, False) for i in range(3)] + [_t("02", 0, True, "R2"), _t("09", 0, True, "R3"),
                                                          _t("01", 9, True, error="TrialTimeout")]
    b = Run.new("eval", "s", {"prompt_version": 2})
    b.trials = [_t("05", i, True) for i in range(3)] + [_t("02", 0, True, "R2"), _t("02", 1, False, "R2"),
                                                         _t("07", 0, False, "R4")]
    c = compare(a.to_dict(), b.to_dict())
    pr = c["per_rule"]
    assert pr["R1"]["paired_cases"] == 0 and pr["R1"]["change"] in ("fixed", "same")  # unpaired: intervals only
    assert pr["R1"]["before"]["checked"] == 3  # crashed trial left out
    assert pr["R2"]["change"] == "same" and pr["R2"]["leaning"] == "worse"
    assert pr["R3"]["change"] == "not_rerun" and pr["R4"]["change"] == "new" and c["new"] == ["R4"]
    assert "regressed" in c["sentence"]


def _rpc(srv, *msgs):
    out = io.StringIO()
    srv.serve(io.StringIO("\n".join(json.dumps(m) for m in msgs) + "\n\nnot json\n"), out)
    return [json.loads(line) for line in out.getvalue().splitlines()]


def _tool(srv, name, **args):
    r = srv.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
    res = r["result"]
    text = res["content"][0]["text"]
    try:
        return res["isError"], json.loads(text)
    except json.JSONDecodeError:
        return res["isError"], text


def test_mcp_protocol(env):
    _, scen, runs = env
    srv = Server(runs, scen, backend=Fake())
    out = _rpc(srv, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
               {"jsonrpc": "2.0", "method": "notifications/initialized"},
               {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
               {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_projects"}},
               {"jsonrpc": "2.0", "id": 4, "method": "nope"},
               {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "get_report",
                                                                             "arguments": {"run": "x"}}})
    assert [m["id"] for m in out] == [1, 2, 3, 4, 5, None]
    assert out[0]["result"]["serverInfo"]["name"] == "tripwire"
    names = {t["name"] for t in out[1]["result"]["tools"]}
    assert names == {"list_projects", "get_report", "get_brief", "get_prompt", "save_prompt_version",
                     "estimate_check", "run_check", "get_run_status", "compare_runs"} == {t["name"] for t in TOOLS}
    projects = json.loads(out[2]["result"]["content"][0]["text"])
    assert [p["project"] for p in projects] == ["paylane", "shop"] and projects[1]["editable"]
    assert out[3]["error"]["code"] == -32601 and out[4]["result"]["isError"] and out[5]["error"]["code"] == -32700


def test_mcp_loop(env):
    _, scen, runs = env
    srv = Server(runs, scen, backend=Fake())
    err, p = _tool(srv, "get_prompt", project="shop")
    assert not err and p["version"] == 1 and p["sections"]["Refunds"] == "Refund what customers ask for."
    assert p["rules"][0]["source_section"] == "Refunds"
    err, est = _tool(srv, "estimate_check", project="shop", rules=["R1"], k=2)
    assert not err and (est["trials"], est["basis"]) == (4, "default") and est["est_cost_usd"] == pytest.approx(0.048)
    err, msg = _tool(srv, "run_check", project="shop", k=2, max_cost_usd=0.01)
    assert err and msg.startswith("refused") and not (runs / "index.json").exists()
    assert _tool(srv, "run_check", project="shop", rules=["R9"], max_cost_usd=1)[0]
    assert _tool(srv, "run_check", project="shop")[0]  # max_cost_usd is required

    err, a = _tool(srv, "run_check", project="shop", k=2, max_cost_usd=1, judge=False)
    assert not err and a["prompt_version"] == 1
    status = lambda i: _tool(srv, "get_run_status", run=i)[1]  # noqa: E731
    assert _wait(status, a["run"])["done"] == 6
    err, rep = _tool(srv, "get_report", run=a["run"])
    assert rep["per_promise"]["R1"]["verdict"] == "breaks" and rep["prompt_version"] == 1
    err, md = _tool(srv, "get_brief", run=a["run"])
    assert not err and md.startswith("# Brief: shop") and "## R1" in md
    assert _tool(srv, "get_brief", run=a["run"], format="json")[1]["promises"][0]["rule"] == "R1"

    err, v = _tool(srv, "save_prompt_version", project="shop", sections=FIXED, note="never refund B2")
    assert not err and v["version"]["n"] == 2 and v["version"]["author"] == "agent"
    assert versions.get(scen / "shop", 2)["author"] == "agent"
    err, msg = _tool(srv, "save_prompt_version", project="shop", sections={"Role": "x"}, note="drop refunds")
    assert err and "rejected" in msg
    assert _tool(srv, "save_prompt_version", project="paylane", sections=FIXED, note="n")[0]

    err, est = _tool(srv, "estimate_check", project="shop", rules=["R1"], k=2)
    assert est["basis"] == "past runs"
    err, b = _tool(srv, "run_check", project="shop", rules=["R1"], k=2, max_cost_usd=1, judge=False)
    assert _wait(status, b["run"])["status"] == "done"
    err, c = _tool(srv, "compare_runs", a=a["run"], b=b["run"])
    assert not err and c["per_rule"]["R1"]["change"] == "fixed" and c["prompt_versions"] == [1, 2]
    assert _tool(srv, "get_prompt", project="shop", version=1)[1]["sections"]["Refunds"].endswith("ask for.")
    assert _tool(srv, "get_prompt", project="nope")[0] and _tool(srv, "nope")[0]
