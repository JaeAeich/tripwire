"""Load a scenario folder.

scenarios/<name>/
  scenario.yaml   name, rules (with ids), env, defaults
  prompt.md       agent prompt, split into '## Section' parts
  cases/*.yaml    one conversation each

v1 (python): env: "env.py:ClassName"
  env.py          Environment subclass (+ optional CHECKS dict of custom checks)
  fixtures.json   initial state

v2 (simulated): env: simulated
  tools.yaml      [{name, description, input_schema, mutates}]
  world.md        plain words: what data exists, business facts (optional)
  fixtures.json   seed records the tool simulator stays consistent with (optional)
"""

from __future__ import annotations

import copy
import importlib.util
import json
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from tripwire.core.agent import parse_sections


@dataclass
class Scenario:
    name: str
    root: Path
    description: str
    rules: dict[str, dict]
    env_cls: type
    fixtures: dict
    sections: dict[str, str]
    cases: list[dict]
    custom_checks: dict = field(default_factory=dict)
    defaults: dict = field(default_factory=dict)
    env_kind: str = "python"  # "python" | "simulated"
    tools: list[dict] = field(default_factory=list)  # simulated: specs from tools.yaml (with `mutates`)
    world: str = ""
    tools_model: str | None = None  # simulated: defaults.models.tools
    notes: list[str] = field(default_factory=list)
    title: str = ""  # display name; the folder name (slug) stays the id

    def case(self, case_id: str) -> dict:
        return next(c for c in self.cases if c["id"] == case_id)


def load_scenario(path: str | Path) -> Scenario:
    root = Path(path).resolve()
    meta = yaml.safe_load((root / "scenario.yaml").read_text())
    cases = [yaml.safe_load(p.read_text()) for p in sorted((root / "cases").glob("*.yaml"))]
    for c in cases:
        c["id"] = str(c["id"])
        c.setdefault("title", c["id"])
    defaults = copy.deepcopy(meta.get("defaults") or {})
    # models.tools is the simulator's model; kept off defaults.models so Models(**models) stays valid
    tools_model = (defaults.get("models") or {}).pop("tools", None)
    common = dict(
        name=meta["name"],
        root=root,
        description=meta.get("description", ""),
        rules={r["id"]: r for r in meta.get("rules") or []},
        sections=parse_sections((root / meta.get("prompt", "prompt.md")).read_text()),
        cases=cases,
        defaults=defaults,
        notes=list(meta.get("notes") or []),
        title=str(meta.get("title") or ""),
    )
    env = meta.get("env", "env.py:Env")
    if env == "simulated":
        from tripwire.core.simenv import make_env_cls

        tools = _read(root, meta.get("tools", "tools.yaml"), yaml.safe_load) or []
        world = (_read(root, meta.get("world", "world.md"), lambda t: t) or "").strip()
        fixtures = _read(root, meta.get("fixtures", "fixtures.json"), json.loads) or {}
        return Scenario(**common, env_cls=make_env_cls(meta["name"], tools, world, tools_model), fixtures=fixtures,
                        env_kind="simulated", tools=tools, world=world, tools_model=tools_model)
    env_file, env_name = env.split(":")
    module = _import(root / env_file, f"tripwire_scenario_{meta['name']}")
    return Scenario(
        **common,
        env_cls=getattr(module, env_name),
        fixtures=json.loads((root / meta.get("fixtures", "fixtures.json")).read_text()),
        custom_checks=getattr(module, "CHECKS", {}),
    )


CASE_KEYS = ("id", "title", "why", "kind", "persona", "script", "max_turns", "checks")


def case_hash(case: dict) -> str:
    """Short fingerprint of what a case asks and checks. Runs record it so the UI can say "edited since"."""
    import hashlib

    body = {k: case.get(k) for k in CASE_KEYS if k in ("persona", "script", "max_turns", "checks") and case.get(k) is not None}
    return hashlib.sha1(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:10]


def _read(root: Path, name: str | None, parse):
    p = root / name if name else None
    return parse(p.read_text()) if p and p.exists() else None


def _import(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
