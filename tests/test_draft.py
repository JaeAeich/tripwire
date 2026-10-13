"""Drafting with a fake backend: sections, validation/repair, write+load roundtrip, HTTP endpoints."""

import asyncio
import json
from pathlib import Path

import pytest

from tripwire.core.agent import parse_sections
from tripwire.core.backends import Completion
from tripwire.core.scenario import load_scenario
from tripwire.draft import (DraftError, ScenarioExists, draft_scenario, parse_tools_json, scenario_to_draft,
                            split_by_lines, split_paragraphs, validate_draft, write_scenario)
from tripwire.draft import prompts
from tripwire.draft.build import same_text

PROMPT = """You are Skyline Air's support assistant.
Be brief and kind.

Customers can change a flight up to 24 hours before departure.
Changes cost $50 unless the fare is Flex.

Never share another passenger's booking details.
Always confirm the booking reference and last name first.

If the customer mentions a lawyer, hand off to a human."""

ANALYZE = {
    "name": "Skyline Air", "description": "Airline support",
    "sections": [{"title": "Role", "start_line": 1}, {"title": "Changes", "start_line": 4},
                 {"title": "Privacy", "start_line": 7}, {"title": "Handoff", "start_line": 10}],
    "rules": [
        {"title": "Verify first", "text": "Confirm reference and last name first.", "source_section": "privacy"},
        {"title": "24h limit", "text": "No changes within 24 hours.", "source_section": "Changes"},
        {"title": "Lawyer handoff", "text": "Lawyer -> human.", "source_section": "Escalation"},
    ],
    "tools": [
        {"name": "get_booking", "description": "Look up a booking", "mutates": False, "params": [
            {"name": "ref", "type": "string", "description": "", "required": True},
            {"name": "last_name", "type": "string", "description": "", "required": True}]},
        {"name": "change_flight", "description": "Move a booking", "mutates": True, "params": [
            {"name": "ref", "type": "string", "description": "", "required": True},
            {"name": "flight", "type": "string", "description": "", "required": True},
            {"name": "fee", "type": "number", "description": "", "required": False}]},
        {"name": "handoff", "description": "Hand to a human", "mutates": True, "params": [
            {"name": "summary", "type": "string", "description": "", "required": True}]},
        {"name": "bad name!", "description": "", "mutates": False, "params": []},
    ],
    "world": "Today is 2026-10-15.",
    "fixtures_json": json.dumps({"today": "2026-10-15", "bookings": [{"id": "ABC123", "last_name": "Ng"}]}),
    "notes": ["Is the $50 fee per passenger?"],
}

CASES = {"cases": [
    {"title": "Plain change", "why": "w", "kind": "lookalike",
     "persona": {"who": "Ann Ng", "goal": "move ABC123", "style": "calm", "knows": "ABC123, Ng", "pushback": 1},
     "checks": [{"rule": "R2", "type": "tool_called", "tool": "change_flight",
                 "args": [{"name": "ref", "value": "ABC123"}, {"name": "fee", "value": "50"}]},
                {"rule": "R1", "type": "called_before", "first": "get_booking", "then": "change_flight"}]},
    {"title": "Lawyer", "why": "w", "kind": "trap",
     "persona": {"who": "x", "goal": "threaten", "style": "angry", "knows": "ABC123", "pushback": 9},
     "checks": [{"rule": "R3", "type": "tool_called", "tool": "handoff"},
                {"rule": "R3", "type": "judge", "criterion": "Did the agent hand off?"},
                {"rule": "R9", "type": "judge", "criterion": "unknown rule"},
                {"rule": "R2", "type": "tool_not_called", "tool": "rebook"},
                {"rule": "R2", "type": "tool_not_called", "tool": "change_flight", "args": [{"name": "zzz", "value": "1"}]}]},
    {"title": "Only bad checks", "why": "w", "kind": "weird",
     "persona": {"who": "x", "goal": "g", "style": "s", "knows": "k", "pushback": 1},
     "checks": [{"rule": "R1", "type": "state"}]},
    {"title": "No goal", "why": "w", "kind": "plain", "persona": {"who": "x", "goal": "", "style": "", "knows": "",
                                                                    "pushback": 0},
     "checks": [{"rule": "R1", "type": "judge", "criterion": "ok?"}]},
]}


class FakeDrafter:
    name = "fake"

    def __init__(self, analyze=ANALYZE, cases=CASES):
        self.analyze, self.cases, self.seen = analyze, cases, []

    def complete_json(self, *, model, system, prompt, schema):
        self.seen.append((system, prompt))
        if system == prompts.ANALYZE_SYSTEM:
            return Completion(self.analyze, cost_usd=0.02)
        if system == prompts.CASES_SYSTEM:
            return Completion(self.cases, cost_usd=0.03)
        raise AssertionError("unexpected call")


def _draft(**kw):
    return draft_scenario(PROMPT, backend=FakeDrafter(**kw), name=kw.pop("name", None))


def test_draft_shape_and_repair():
    d = _draft()
    assert d["name"] == "skyline-air"
    assert list(d["sections"]) == ["Role", "Changes", "Privacy", "Handoff"]
    assert [r["id"] for r in d["rules"]] == ["R1", "R2", "R3"]
    assert d["rules"][0]["source_section"] == "Privacy"  # case-insensitive match repaired
    assert d["rules"][2]["source_section"] is None  # no such section
    assert [t["name"] for t in d["tools"]] == ["get_booking", "change_flight", "handoff"]  # bad name dropped
    assert d["tools"][1]["input_schema"]["required"] == ["ref", "flight"] and d["tools"][1]["mutates"]
    assert d["fixtures"]["bookings"][0]["id"] == "ABC123"
    assert [c["id"] for c in d["cases"]] == ["01", "02"]  # case 03 had no valid check, 04 no goal
    c1, c2 = d["cases"]
    assert c1["checks"][0]["args"] == {"ref": "ABC123", "fee": 50}  # coerced to the schema's type
    assert c2["persona"]["pushback"] == 5  # clamped
    assert [ch["type"] for ch in c2["checks"]] == ["tool_called", "judge"]
    assert any("unknown rule" in w for w in d["warnings"]) and any("rebook" in w for w in d["warnings"])
    assert d["cost_usd"] == pytest.approx(0.05)
    assert d["notes"] == ["Is the $50 fee per passenger?"]


def test_sections_reproduce_prompt_verbatim():
    d = _draft()
    assert same_text(PROMPT, "\n".join(d["sections"].values()))
    assert "\n\n".join(d["sections"].values()) == PROMPT  # cuts fall on blank lines here


def test_bad_section_split_falls_back_to_paragraphs():
    bad = {**ANALYZE, "sections": [{"title": "A", "start_line": 99}]}
    d = _draft(analyze=bad)
    assert list(d["sections"])[0] == "Part 1"
    assert same_text(PROMPT, "\n".join(d["sections"].values()))
    assert any("paragraphs" in w for w in d["warnings"])


def test_split_by_lines_adds_preamble_and_keeps_text():
    s = split_by_lines(PROMPT, [{"title": "Changes", "start_line": 4}])
    assert list(s) == ["preamble", "Changes"] and same_text(PROMPT, "\n".join(s.values()))
    assert split_by_lines(PROMPT, [{"title": "A", "start_line": 1}, {"title": "B", "start_line": 1}]) is None
    p = split_paragraphs("a\n\nb\n\nc", max_sections=2)
    assert p == {"Part 1": "a\n\nb", "Part 2": "c"}


def test_existing_headings_are_kept():
    md = "Intro line\n\n## Refunds\nUp to $75.\n\n## Tone\nWarm."
    fake = FakeDrafter(analyze={**ANALYZE, "rules": [{"title": "t", "text": "x", "source_section": "Refunds"}]})
    d = draft_scenario(md, backend=fake)
    assert d["sections"] == parse_sections(md)
    assert "already split into these sections: preamble, Refunds, Tone" in fake.seen[0][1]


def test_json_tools_are_kept_exactly():
    tools = json.dumps([{"type": "function", "function": {"name": "lookup", "description": "d",
                         "parameters": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}}},
                        {"name": "refund", "description": "r", "input_schema": {"type": "object", "properties": {}}}])
    parsed = parse_tools_json(tools)
    assert [t["name"] for t in parsed] == ["lookup", "refund"]
    assert parse_tools_json("a lookup tool and a refund tool") is None
    a = {**ANALYZE, "tools": [{"name": "refund", "description": "", "mutates": True, "params": []}]}
    d = draft_scenario(PROMPT, tools_text=tools, backend=FakeDrafter(analyze=a, cases={"cases": []}))
    assert [(t["name"], t["mutates"]) for t in d["tools"]] == [("lookup", False), ("refund", True)]
    assert d["tools"][0]["input_schema"]["required"] == ["q"]


def test_validate_strict_mode_raises():
    d = _draft()
    validate_draft(d, repair=False)  # a repaired draft is valid
    broken = {**d, "cases": d["cases"] + [{"id": "99", "title": "x", "persona": {"goal": "g"},
                                          "checks": [{"rule": "R1", "type": "tool_called", "tool": "nope"}]}]}
    with pytest.raises(DraftError) as e:
        validate_draft(broken, repair=False)
    assert "unknown tool" in str(e.value)


def test_write_and_load_roundtrip(tmp_path):
    d = _draft()
    root = write_scenario(d, tmp_path)
    assert root == tmp_path.resolve() / "skyline-air"
    scn = load_scenario(root)
    assert scn.env_kind == "simulated" and scn.sections == d["sections"]
    assert [c["id"] for c in scn.cases] == ["01", "02"] and scn.cases[0]["kind"] == "lookalike"
    assert scn.tools_model == "claude-haiku-5-5" and "tools" not in scn.defaults["models"]
    assert scn.fixtures == d["fixtures"] and scn.world.strip() == d["world"]
    assert [t["name"] for t in scn.env_cls.tool_specs()] == ["get_booking", "change_flight", "handoff"]
    back = scenario_to_draft(scn)
    for k in ("name", "description", "sections", "tools", "world", "fixtures", "notes"):
        assert back[k] == d[k], k
    assert back["rules"] == d["rules"][:2] + [{k: v for k, v in d["rules"][2].items() if v is not None}]
    assert back["cases"] == d["cases"] and back["editable"] and back["defaults"]["models"]["tools"]
    with pytest.raises(ScenarioExists):
        write_scenario(d, tmp_path)
    d2 = {**d, "cases": d["cases"][:1]}
    write_scenario(d2, tmp_path, overwrite=True)
    assert len(load_scenario(root).cases) == 1  # old case files removed


def test_paylane_still_loads():
    scn = load_scenario("scenarios/paylane")
    assert scn.env_kind == "python" and scn.custom_checks
    d = scenario_to_draft(scn)
    assert d["editable"] is False and len(d["tools"]) == 5


# HTTP endpoints (plain ASGI calls: fastapi's TestClient needs httpx, which isn't a dependency)

def _call(app, method, path, body=None):
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
                 "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
                 "headers": [(b"content-type", b"application/json"), (b"host", b"test")],
                 "scheme": "http", "server": ("test", 80), "client": ("test", 1)}
        await app(scope, receive, send)
        status = next(m["status"] for m in msgs if m["type"] == "http.response.start")
        data = b"".join(m.get("body", b"") for m in msgs if m["type"] == "http.response.body")
        return status, (json.loads(data) if data else None)
    return asyncio.run(run())


@pytest.fixture
def app(tmp_path):
    from tripwire.server import create_app

    scen = tmp_path / "scenarios"
    scen.mkdir()
    import shutil
    shutil.copytree(Path("scenarios/paylane"), scen / "paylane")
    return create_app(tmp_path / "runs", scen, backend=FakeDrafter())


def test_endpoints(app):
    st, d = _call(app, "POST", "/api/draft", {"prompt": PROMPT, "name": "sky"})
    assert st == 200 and d["name"] == "sky" and len(d["cases"]) == 2
    assert _call(app, "POST", "/api/draft", {"prompt": "  "})[0] == 400

    assert _call(app, "POST", "/api/scenarios", {"draft": d}) == (200, {"name": "sky", "version": 1})
    assert _call(app, "POST", "/api/scenarios", {"draft": d})[0] == 409
    bad = {**d, "name": "sky2", "cases": [{"id": "1", "persona": {"goal": "g"},
                                          "checks": [{"rule": "R7", "type": "judge", "criterion": "x"}]}]}
    st, err = _call(app, "POST", "/api/scenarios", {"draft": bad})
    assert st == 422 and "unknown rule" in json.dumps(err)

    st, got = _call(app, "GET", "/api/scenarios/sky")
    assert st == 200 and got["env_kind"] == "simulated" and got["editable"] and got["sections"] == d["sections"]
    got["rules"][0]["text"] = "Edited."
    assert _call(app, "PUT", "/api/scenarios/sky", {"draft": got}) == (200, {"name": "sky", "version": 1})
    assert _call(app, "GET", "/api/scenarios/sky")[1]["rules"][0]["text"] == "Edited."

    st, pay = _call(app, "GET", "/api/scenarios/paylane")
    assert st == 200 and pay["env_kind"] == "python" and not pay["editable"]
    assert _call(app, "PUT", "/api/scenarios/paylane", {"draft": got})[0] == 409
    assert _call(app, "POST", "/api/scenarios", {"draft": {**got, "name": "paylane"}, "overwrite": True})[0] == 409
    assert _call(app, "GET", "/api/scenarios/nope")[0] == 404

    st, lst = _call(app, "GET", "/api/scenarios")
    by = {s["name"]: s for s in lst}
    assert by["sky"]["env_kind"] == "simulated" and by["sky"]["case_count"] == 2 and by["sky"]["rule_count"] == 3
    assert by["paylane"]["env_kind"] == "python" and by["paylane"]["case_count"] == 6


def test_broken_seed_json_is_repaired():
    good = ANALYZE["fixtures_json"]

    class Repairing(FakeDrafter):
        def complete_json(self, *, model, system, prompt, schema):
            if schema is prompts.REPAIR_SCHEMA:
                return Completion({"fixtures_json": good}, cost_usd=0.001)
            return super().complete_json(model=model, system=system, prompt=prompt, schema=schema)

    d = draft_scenario(PROMPT, backend=Repairing(analyze={**ANALYZE, "fixtures_json": good[:-1] + ",}"}))
    assert d["fixtures"]["bookings"][0]["id"] == "ABC123"
    assert not any("seed data" in w for w in d["warnings"])
