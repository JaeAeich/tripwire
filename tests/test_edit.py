"""Editing from the UI: lossless round trip, title/defaults, part renames, project rename, run labels. No model calls."""

import copy
import json
import shutil
from pathlib import Path

import pytest

from tripwire.core.scenario import case_hash, load_scenario
from tripwire.core.trace import Run
from tripwire.versions import history

from test_draft import _call

SCN = "threadbare-returns"


@pytest.fixture
def env(tmp_path):
    from tripwire.server import create_app

    scen = tmp_path / "scenarios"
    scen.mkdir()
    shutil.copytree(Path("scenarios") / SCN, scen / SCN, ignore=shutil.ignore_patterns("versions"))
    shutil.copytree(Path("scenarios/paylane"), scen / "paylane")
    runs = tmp_path / "runs"
    return create_app(runs, scen, backend=object()), scen, runs


def test_get_put_round_trip_loses_nothing(env):
    app, scen, _ = env
    st, got = _call(app, "GET", f"/api/scenarios/{SCN}")
    assert st == 200 and got["defaults"]["models"]["tools"]
    before = (scen / SCN / "scenario.yaml").read_text()
    n_versions = len(history(scen / SCN))
    assert _call(app, "PUT", f"/api/scenarios/{SCN}", {"draft": got})[0] == 200
    assert _call(app, "GET", f"/api/scenarios/{SCN}")[1] == got
    assert (scen / SCN / "scenario.yaml").read_text() == before
    assert len(history(scen / SCN)) == n_versions  # unchanged prompt: no new version

    # the fields the old UI dropped: models, default tries, a scripted case, max_turns, the title
    edited = copy.deepcopy(got)
    edited["title"] = "Threadbare returns desk"
    edited["defaults"] = {"models": {**got["defaults"]["models"], "agent": "claude-sonnet-5-5"}, "k": 5}
    edited["cases"][0]["max_turns"] = 4
    edited["cases"][1] = {k: v for k, v in edited["cases"][1].items() if k != "persona"}
    edited["cases"][1]["script"] = ["Hi, is TB-1001 mine?", "My email is a@b.c"]
    assert _call(app, "PUT", f"/api/scenarios/{SCN}", {"draft": edited})[0] == 200
    again = _call(app, "GET", f"/api/scenarios/{SCN}")[1]
    assert again == edited
    scn = load_scenario(scen / SCN)
    assert scn.title == "Threadbare returns desk" and scn.defaults["k"] == 5 and scn.tools_model
    assert scn.defaults["models"]["agent"] == "claude-sonnet-5-5" and "tools" not in scn.defaults["models"]
    lst = {s["name"]: s for s in _call(app, "GET", "/api/scenarios")[1]}[SCN]
    assert lst["title"] == "Threadbare returns desk" and lst["cases"][0]["max_turns"] == 4
    assert lst["cases"][0]["hash"] == case_hash(scn.cases[0])

    for bad in ({"k": 0}, {"k": "x"}, {"models": {"planner": "m"}}):
        assert _call(app, "PUT", f"/api/scenarios/{SCN}", {"draft": {**got, "defaults": bad}})[0] == 422
    bad_case = copy.deepcopy(got)
    bad_case["cases"][0]["max_turns"] = 99
    assert _call(app, "PUT", f"/api/scenarios/{SCN}", {"draft": bad_case})[0] == 422


def test_case_hash_tracks_what_the_test_does():
    c = {"id": "01", "title": "t", "why": "w", "kind": "plain", "persona": {"goal": "g"},
         "checks": [{"rule": "R1", "type": "judge", "criterion": "c"}]}
    h = case_hash(c)
    assert case_hash({**c, "title": "renamed", "why": "other", "kind": "trap"}) == h
    assert case_hash({**c, "persona": {"goal": "g2"}}) != h
    assert case_hash({**c, "max_turns": 3}) != h


def test_prompt_renames_move_promises(env):
    app, scen, _ = env
    got = _call(app, "GET", f"/api/scenarios/{SCN}")[1]
    sections = got["sections"]
    old = "Order verification"
    assert old in sections and any(r.get("source_section") == old for r in got["rules"])
    renamed = {("Verification" if k == old else k): v for k, v in sections.items()}
    # without renames the promises would point at a part that is gone
    st, err = _call(app, "PUT", f"/api/scenarios/{SCN}/prompt", {"sections": renamed})
    assert st == 422 and "source section" in json.dumps(err)
    st, out = _call(app, "PUT", f"/api/scenarios/{SCN}/prompt",
                    {"sections": renamed, "note": "rename", "renames": {old: "Verification"}})
    assert st == 200 and out["changed"] and "Verification" in out["version"]["sections"]
    after = _call(app, "GET", f"/api/scenarios/{SCN}")[1]
    assert list(after["sections"]) == list(renamed)
    moved = [r["id"] for r in got["rules"] if r.get("source_section") == old]
    assert all(r["source_section"] == "Verification" for r in after["rules"] if r["id"] in moved)

    # remove a part: its promises become about the whole prompt
    gone = {k: v for k, v in renamed.items() if k != "Verification"}
    st, _ = _call(app, "PUT", f"/api/scenarios/{SCN}/prompt", {"sections": gone, "renames": {"Verification": None}})
    assert st == 200
    after = _call(app, "GET", f"/api/scenarios/{SCN}")[1]
    assert all("source_section" not in r for r in after["rules"] if r["id"] in moved)
    assert "Verification" not in after["sections"]

    # reorder + add a part
    order = list(gone)[::-1]
    st, _ = _call(app, "PUT", f"/api/scenarios/{SCN}/prompt",
                  {"sections": {**{k: gone[k] for k in order}, "Escalation": "Hand off when unsure."}})
    assert st == 200 and list(_call(app, "GET", f"/api/scenarios/{SCN}")[1]["sections"]) == order + ["Escalation"]


def test_rename_project_moves_folder_and_runs(env):
    app, scen, runs = env
    root = (scen / SCN).resolve()
    r = Run.new("eval", SCN, {"scenario_path": str(root), "k": 1})
    r.status = "done"
    r.save(runs)
    other = Run.new("eval", "paylane", {"k": 1})
    other.status = "done"
    other.save(runs)

    assert _call(app, "POST", f"/api/scenarios/{SCN}/rename", {"to": "paylane"})[0] == 409
    assert _call(app, "POST", "/api/scenarios/paylane/rename", {"to": "pl"})[0] == 409  # python: read-only
    assert _call(app, "POST", "/api/scenarios/nope/rename", {"to": "x"})[0] == 404
    st, out = _call(app, "POST", f"/api/scenarios/{SCN}/rename", {"to": "Returns Desk"})
    assert st == 200 and out == {"name": "returns-desk", "runs": 1}
    assert not root.exists() and (scen / "returns-desk" / "scenario.yaml").exists()
    assert _call(app, "GET", f"/api/scenarios/{SCN}")[0] == 404
    got = _call(app, "GET", "/api/scenarios/returns-desk")[1]
    assert got["name"] == "returns-desk" and load_scenario(scen / "returns-desk").name == "returns-desk"
    run = _call(app, "GET", f"/api/runs/{r.id}")[1]
    assert run["scenario"] == "returns-desk"
    assert run["config"]["scenario_path"] == str((scen / "returns-desk").resolve())
    idx = {e["id"]: e for e in _call(app, "GET", "/api/runs")[1]}
    assert idx[r.id]["scenario"] == "returns-desk" and idx[other.id]["scenario"] == "paylane"
    assert len(history(scen / "returns-desk")) >= 1  # versions moved with it
    assert _call(app, "POST", "/api/scenarios/returns-desk/rename", {"to": "returns-desk"})[1]["runs"] == 0


def test_run_label(env):
    app, _, runs = env
    r = Run.new("eval", SCN, {"k": 1})
    r.status = "done"
    r.save(runs)
    st, out = _call(app, "PATCH", f"/api/runs/{r.id}", {"label": "  after   refund rewrite "})
    assert st == 200 and out["label"] == "after refund rewrite"
    assert _call(app, "GET", f"/api/runs/{r.id}")[1]["config"]["label"] == "after refund rewrite"
    assert _call(app, "GET", "/api/runs")[1][0]["config"]["label"] == "after refund rewrite"
    assert _call(app, "PATCH", f"/api/runs/{r.id}", {"label": ""})[0] == 200
    assert "label" not in _call(app, "GET", f"/api/runs/{r.id}")[1]["config"]
    assert _call(app, "PATCH", "/api/runs/nope", {"label": "x"})[0] == 404
    # a later save by the runner keeps the label (it lives in config)
    _call(app, "PATCH", f"/api/runs/{r.id}", {"label": "v2"})
    from tripwire.core.trace import load_run, run_from_dict
    again = run_from_dict(load_run(runs / r.id / "run.json"))
    again.save(runs)
    assert _call(app, "GET", "/api/runs")[1][0]["config"]["label"] == "v2"
