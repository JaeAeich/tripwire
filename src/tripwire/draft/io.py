"""Draft <-> scenario folder (format v2, `env: simulated`)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import yaml

from tripwire.core.agent import render_sections
from tripwire.core.scenario import CASE_KEYS, Scenario
from tripwire.core.simenv import DEFAULT_TOOLS_MODEL
from tripwire.draft.validate import slugify, validate_draft

DEFAULT_MODELS = {"agent": "claude-haiku-5-5", "user": "claude-haiku-5-5", "judge": "claude-sonnet-5-5",
                  "tools": DEFAULT_TOOLS_MODEL}
_GENERATED = ("scenario.yaml", "prompt.md", "tools.yaml", "world.md", "fixtures.json")


class ScenarioExists(FileExistsError):
    pass


def write_scenario(draft: dict, scenarios_dir: str | Path, overwrite: bool = False) -> Path:
    """Write a Draft as scenarios_dir/<slug>/. Raises DraftError if invalid, ScenarioExists if taken."""
    d, _ = validate_draft(draft, repair=False)
    root = Path(scenarios_dir).resolve() / d["name"]
    if (root / "scenario.yaml").exists():
        if not overwrite:
            raise ScenarioExists(f"scenario {d['name']} already exists")
        meta = yaml.safe_load((root / "scenario.yaml").read_text()) or {}
        if meta.get("env", "env.py:Env") != "simulated":
            raise ScenarioExists(f"scenario {d['name']} is a Python scenario; it can't be overwritten from a draft")
        shutil.rmtree(root / "cases", ignore_errors=True)
        for f in _GENERATED:
            (root / f).unlink(missing_ok=True)
    (root / "cases").mkdir(parents=True, exist_ok=True)

    defaults = dict(d.get("defaults") or {})
    defaults["models"] = {**DEFAULT_MODELS, **(defaults.get("models") or {})}
    meta = {"name": d["name"]}
    if d.get("title"):
        meta["title"] = d["title"]
    meta.update({"description": d["description"], "prompt": "prompt.md", "env": "simulated", "tools": "tools.yaml"})
    if d["world"].strip():
        meta["world"] = "world.md"
        (root / "world.md").write_text(d["world"].strip() + "\n")
    if d["fixtures"]:
        meta["fixtures"] = "fixtures.json"
        (root / "fixtures.json").write_text(json.dumps(d["fixtures"], indent=1) + "\n")
    meta["rules"] = [{k: r[k] for k in ("id", "title", "text", "source_section") if r.get(k) is not None}
                     for r in d["rules"]]
    meta["defaults"] = defaults
    if d["notes"]:
        meta["notes"] = d["notes"]
    (root / "scenario.yaml").write_text(_dump(meta))
    (root / "prompt.md").write_text(render_sections(d["sections"]) + "\n")
    (root / "tools.yaml").write_text(_dump(d["tools"]))
    for c in d["cases"]:
        body = {k: c[k] for k in CASE_KEYS if k in c}
        (root / "cases" / f"{c['id']}_{slugify(c['title'])[:40]}.yaml").write_text(_dump(body))
    return root


def scenario_to_draft(scn: Scenario) -> dict:
    """A loaded scenario in Draft shape (+ env_kind, editable, defaults)."""
    simulated = scn.env_kind == "simulated"
    if simulated:
        tools = [dict(t) for t in scn.tools]
    else:
        tools = [{**t, "mutates": None} for t in scn.env_cls.tool_specs()]
    models = dict((scn.defaults.get("models") or {}))
    if scn.tools_model:
        models["tools"] = scn.tools_model
    defaults = {**scn.defaults, "models": models}
    return {
        "name": scn.name,
        "title": scn.title,
        "description": scn.description,
        "sections": dict(scn.sections),
        "rules": list(scn.rules.values()),
        "tools": tools,
        "world": scn.world,
        "fixtures": scn.fixtures,
        "cases": [{k: c[k] for k in CASE_KEYS if k in c} for c in scn.cases],
        "notes": list(scn.notes),
        "defaults": defaults,
        "env_kind": scn.env_kind,
        "editable": simulated,
    }


def _dump(x) -> str:
    return yaml.safe_dump(x, sort_keys=False, allow_unicode=True, width=110, default_flow_style=False)
