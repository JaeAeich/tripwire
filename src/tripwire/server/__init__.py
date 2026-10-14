"""Local API for the UI. Runs execute in background threads and write run.json as
they go, so the UI just polls GET /api/runs/{id}.

GET  /api/health                 backend name
GET  /api/scenarios              scenarios with rules, prompt sections, cases
GET  /api/runs                   runs/index.json
GET  /api/runs/{id}              full run
POST /api/runs                   {"kind": "eval", "scenario": "paylane", "k": 3, "cases": [...], "judge": true,
                                  "rules": ["R3"], "prompt_version": 2}   (rules: only cases checking them)
                                 {"kind": "attribute", "base_run": "<id>", "k": 5, "sections": [...]}
POST /api/runs/{id}/stop         stop a run started by this server (finished trials are kept)
GET  /api/runs/{id}/brief        ?rule=R3&section=Refunds&format=md|json  evidence for fixing the prompt
GET  /api/runs/{id}/compare/{b}  per promise before/after: fixed|regressed|same|new|not_rerun

Drafting (docs/CONTRACT.md has the Draft shape):
POST /api/draft                  {"prompt": "...", "tools": "...", "name": "..."} -> Draft (sync, 30-120 s)
POST /api/scenarios              {"draft": Draft, "overwrite": false} -> {"name"}  (409 if it exists)
GET  /api/scenarios/{name}       Draft-shaped scenario + env_kind, editable
PUT  /api/scenarios/{name}       {"draft": Draft, "note"?} -> {"name", "version"}  (simulated scenarios only)
POST /api/scenarios/{name}/rename {"to": "new-name"} -> {"name", "runs"}  (409 if taken; runs follow the project)
PATCH /api/runs/{id}             {"label": "after refund rewrite"} -> {"id", "label"}

Prompt versions (simulated scenarios; scenarios/<name>/versions/<n>.json):
PUT  /api/scenarios/{name}/prompt      {"sections": {...}, "note"?, "renames"?: {old: new|null}}
                                       -> {"name", "version", "changed"}  (renames move promises' source_section)
GET  /api/scenarios/{name}/versions    [{n, created, note, author, sections: [names]}]
GET  /api/scenarios/{name}/versions/{n} {n, created, note, author, sections}

Attack (docs/CONTRACT.md "Attack"):
POST /api/attacks                {"scenario": "...", "rules": ["R3"], "per_rule": 3, "k": 3} -> {"id"} (async)
POST /api/scenarios/{name}/cases {"cases": [case, ...]} -> {"name", "added": [ids]}  (simulated scenarios only)
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from tripwire import versions
from tripwire.core.backends import get_backend
from tripwire.core.runner import STOPS, Models, stop_run
from tripwire.core.scenario import CASE_KEYS, case_hash, load_scenario
from tripwire.core.trace import Run, load_run
from tripwire.loop import guard as _guard
from tripwire.loop import start_check
from tripwire.draft import DraftError, ScenarioExists, draft_scenario, scenario_to_draft, slugify, write_scenario


class RunRequest(BaseModel):
    kind: str = "eval"
    scenario: str | None = None
    base_run: str | None = None
    k: int = 3
    cases: list[str] | None = None
    sections: list[str] | None = None
    rules: list[str] | None = None
    prompt_version: int | None = None
    judge: bool = True
    agent_model: str | None = None
    workers: int = 4
    trial_timeout_s: float | None = 600


class DraftRequest(BaseModel):
    prompt: str
    tools: str | None = None
    name: str | None = None


class SaveRequest(BaseModel):
    draft: dict
    overwrite: bool = False
    note: str | None = None


class PromptRequest(BaseModel):
    sections: dict[str, str]
    note: str | None = None
    # parts renamed (old -> new) or removed (old -> null) in this save; their promises follow
    renames: dict[str, str | None] | None = None


class RenameRequest(BaseModel):
    to: str


class RunPatch(BaseModel):
    label: str | None = None


class AttackRequest(BaseModel):
    scenario: str | None = None
    base_run: str | None = None
    rules: list[str] | None = None
    per_rule: int = 3
    k: int = 3
    judge: bool = True
    planner_model: str | None = None
    agent_model: str | None = None
    workers: int = 4
    trial_timeout_s: float | None = 600


class CasesRequest(BaseModel):
    cases: list[dict]


def create_app(runs_dir: Path, scenarios_dir: Path, web_dist: Path | None = None, backend=None) -> FastAPI:
    app = FastAPI(title="tripwire")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    backend = backend or get_backend()
    write_lock = threading.Lock()

    def scenario_paths() -> dict[str, Path]:
        return {p.parent.name: p.parent for p in sorted(scenarios_dir.glob("*/scenario.yaml"))}

    @app.get("/api/health")
    def health():
        return {"ok": True, "backend": backend.name, "mode": "local"}

    @app.get("/api/scenarios")
    def scenarios():
        return scenarios_payload(scenarios_dir)

    @app.post("/api/draft")
    def draft(req: DraftRequest):  # sync def: FastAPI runs it in a worker thread
        if not req.prompt.strip():
            raise HTTPException(400, "prompt is empty")
        try:
            return draft_scenario(req.prompt, req.tools, req.name, backend=backend)
        except Exception as e:
            raise HTTPException(502, f"drafting failed: {type(e).__name__}: {e}")

    @app.post("/api/scenarios")
    def create_scenario(req: SaveRequest):
        with write_lock:
            return _save(req.draft, req.overwrite, req.note)

    @app.get("/api/scenarios/{name}")
    def get_scenario(name: str):
        path = scenario_paths().get(name)
        if not path:
            raise HTTPException(404, "scenario not found")
        return {**scenario_to_draft(load_scenario(path)), "name": name}

    @app.put("/api/scenarios/{name}")
    def put_scenario(name: str, req: SaveRequest):
        path = scenario_paths().get(name)
        if not path:
            raise HTTPException(404, "scenario not found")
        if load_scenario(path).env_kind != "simulated":
            raise HTTPException(409, "only simulated scenarios can be edited here")
        with write_lock:
            return _save({**req.draft, "name": name}, overwrite=True, note=req.note)

    def _editable(name: str) -> Path:
        path = scenario_paths().get(name)
        if not path:
            raise HTTPException(404, "scenario not found")
        if load_scenario(path).env_kind != "simulated":
            raise HTTPException(409, "only simulated scenarios can be edited here")
        return path

    @app.put("/api/scenarios/{name}/prompt")
    def put_prompt(name: str, req: PromptRequest):
        with write_lock:
            return save_prompt(_editable(name), req.sections, req.note, "human", req.renames)

    @app.post("/api/scenarios/{name}/rename")
    def rename(name: str, req: RenameRequest):
        path = _editable(name)
        to = slugify(req.to)
        if to == name:
            return {"name": name, "runs": 0}
        with write_lock:
            if (scenarios_dir / to).exists():
                raise HTTPException(409, f"a project called {to} already exists")
            if any(e.get("scenario") == name and e["id"] in STOPS for e in _index()):
                raise HTTPException(409, "a run of this project is still going; rename it once it finishes")
            n = rename_scenario(path, to, runs_dir)
        return {"name": to, "runs": n}

    @app.get("/api/scenarios/{name}/versions")
    def list_versions(name: str):
        return [versions.meta(v) for v in versions.history(_editable(name))]

    @app.get("/api/scenarios/{name}/versions/{n}")
    def get_version(name: str, n: int):
        v = versions.get(_editable(name), n)
        if not v:
            raise HTTPException(404, "version not found")
        return v

    @app.post("/api/scenarios/{name}/cases")
    def add_cases(name: str, req: CasesRequest):
        from tripwire.attack import scenario_case

        path = scenario_paths().get(name)
        if not path:
            raise HTTPException(404, "scenario not found")
        if not req.cases:
            raise HTTPException(400, "no cases")
        with write_lock:
            scn = load_scenario(path)
            if scn.env_kind != "simulated":
                raise HTTPException(409, "only simulated scenarios can be edited here")
            d = scenario_to_draft(scn)
            n = max((int(c["id"]) for c in d["cases"] if str(c["id"]).isdigit()), default=0)
            added = [{**scenario_case(c), "id": f"{n + i + 1:02d}"} for i, c in enumerate(req.cases)]
            _save({**d, "name": name, "cases": d["cases"] + added}, overwrite=True)
        return {"name": name, "added": [c["id"] for c in added]}

    def _save(draft: dict, overwrite: bool, note: str | None = None, author: str = "human") -> dict:
        try:
            return save_draft(draft, scenarios_dir, overwrite, note, author)
        except DraftError as e:
            raise HTTPException(422, {"problems": e.problems})
        except ScenarioExists as e:
            raise HTTPException(409, str(e))

    def save_prompt(path: Path, sections: dict, note: str | None, author: str, renames: dict | None = None) -> dict:
        try:
            return save_sections(path, sections, note, author, renames)
        except DraftError as e:
            raise HTTPException(422, {"problems": e.problems})

    def _index() -> list[dict]:
        idx = runs_dir / "index.json"
        return json.loads(idx.read_text()) if idx.exists() else []

    @app.get("/api/runs")
    def runs():
        return _index()

    @app.patch("/api/runs/{run_id}")
    def patch_run(run_id: str, req: RunPatch):
        p = runs_dir / run_id / "run.json"
        if not p.exists():
            raise HTTPException(404, "run not found")
        if run_id in STOPS:
            raise HTTPException(409, "the run is still going; label it once it finishes")
        label = " ".join((req.label or "").split())[:120]
        set_run_label(runs_dir, run_id, label)
        return {"id": run_id, "label": label}

    @app.get("/api/runs/{run_id}")
    def run(run_id: str):
        p = runs_dir / run_id / "run.json"
        if not p.exists():
            raise HTTPException(404, "run not found")
        return load_run(p)

    def _load(run_id: str) -> dict:
        p = runs_dir / run_id / "run.json"
        if not p.exists():
            raise HTTPException(404, f"run {run_id} not found")
        return load_run(p)

    @app.get("/api/runs/{run_id}/brief")
    def brief(run_id: str, rule: str | None = None, section: str | None = None, format: str = "json"):
        from tripwire.brief import build
        b = build(_load(run_id), rule=rule or None, section=section or None, runs_dir=runs_dir)
        return PlainTextResponse(b["markdown"], media_type="text/markdown") if format == "md" else b

    @app.get("/api/runs/{run_id}/compare/{other}")
    def compare(run_id: str, other: str):
        from tripwire.compare import compare
        a, b = _load(run_id), _load(other)
        if a["scenario"] != b["scenario"]:
            raise HTTPException(400, "runs are of different scenarios")
        return compare(a, b)

    @app.post("/api/runs")
    def start(req: RunRequest):
        if req.kind == "eval":
            path = scenario_paths().get(req.scenario or "")
            if not path:
                raise HTTPException(400, "unknown scenario")
            try:
                run = start_check(load_scenario(path), backend, runs_dir, k=req.k, rules=req.rules, cases=req.cases,
                                  prompt_version=req.prompt_version, judge=req.judge, agent_model=req.agent_model,
                                  workers=req.workers, trial_timeout_s=req.trial_timeout_s)
            except ValueError as e:
                raise HTTPException(400, str(e))
            return {"id": run.id}
        elif req.kind == "attribute":
            base_path = runs_dir / (req.base_run or "") / "run.json"
            if not base_path.exists():
                raise HTTPException(400, "unknown base run")
            base = load_run(base_path)
            if base["status"] == "running":
                raise HTTPException(400, "base run is still running; attribute it once it finishes")
            scn = load_scenario(base["config"]["scenario_path"])
            run = Run.new("attribute", scn.name, {})

            def work():
                from tripwire.attribute import run_attribution
                _guard(run, runs_dir, lambda: run_attribution(scn, base, backend, runs_dir, k=req.k,
                                                              sections=req.sections, case_ids=req.cases,
                                                              workers=req.workers, run=run,
                                                              trial_timeout_s=req.trial_timeout_s))
        else:
            raise HTTPException(400, "kind must be eval or attribute")
        run.save(runs_dir)
        threading.Thread(target=work, daemon=True).start()
        return {"id": run.id}

    @app.post("/api/attacks")
    def attack(req: AttackRequest):
        base = None
        if req.base_run:
            base_path = runs_dir / req.base_run / "run.json"
            if not base_path.exists():
                raise HTTPException(400, "unknown base run")
            base = load_run(base_path)
        path = scenario_paths().get(req.scenario or (base or {}).get("scenario") or "")
        if not path:
            raise HTTPException(400, "unknown scenario")
        scn = load_scenario(path)
        bad = [r for r in req.rules or [] if r not in scn.rules]
        if bad:
            raise HTTPException(400, f"unknown rule(s): {', '.join(bad)}")
        run = Run.new("attack", scn.name, {"rules": req.rules or list(scn.rules), "per_rule": req.per_rule,
                                           "k": req.k})
        stop = STOPS[run.id] = threading.Event()  # so stop works from the first second, while planning

        def work():
            from tripwire.attack import ATTACK_MODEL, run_attack
            models = (Models(**{**base["config"]["models"], **({"agent": req.agent_model} if req.agent_model else {})})
                      if base else Models.from_scenario(scn, agent=req.agent_model))
            _guard(run, runs_dir, lambda: run_attack(scn, backend, runs_dir, rules=req.rules, per_rule=req.per_rule,
                                                     k=req.k, base_run=base, models=models,
                                                     planner=req.planner_model or ATTACK_MODEL,
                                                     workers=req.workers, use_judge=req.judge, run=run,
                                                     stop=stop, trial_timeout_s=req.trial_timeout_s))
            STOPS.pop(run.id, None)
        run.save(runs_dir)
        threading.Thread(target=work, daemon=True).start()
        return {"id": run.id}

    @app.post("/api/runs/{run_id}/stop")
    def stop(run_id: str):
        if not stop_run(run_id):
            raise HTTPException(409, "run is not running in this server (CLI runs stop with Ctrl-C)")
        return {"ok": True}

    if web_dist and web_dist.exists():
        app.mount("/", StaticFiles(directory=web_dist, html=True), name="web")
    return app


def scenarios_payload(scenarios_dir: Path) -> list[dict]:
    out = []
    for path in sorted(scenarios_dir.glob("*/scenario.yaml")):
        s = load_scenario(path.parent)
        out.append({"name": s.name, "title": s.title, "description": s.description, "rules": list(s.rules.values()),
                    "sections": s.sections, "defaults": s.defaults, "env_kind": s.env_kind,
                    "editable": s.env_kind == "simulated", "rule_count": len(s.rules), "case_count": len(s.cases),
                    "notes": list(s.notes),
                    "cases": [{**{k: c.get(k) for k in CASE_KEYS}, "hash": case_hash(c)} for c in s.cases]})
    return out


def rename_scenario(path: Path, to: str, runs_dir: Path) -> int:
    """Move a simulated scenario folder to `to` and point its runs at the new name. -> runs updated."""
    import yaml

    from tripwire.core.trace import _index_lock

    old = path.name
    meta = yaml.safe_load((path / "scenario.yaml").read_text()) or {}
    new_root = path.parent / to
    old_path = str(path.resolve())
    path.rename(new_root)
    meta["name"] = to
    (new_root / "scenario.yaml").write_text(yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, width=110))
    new_path = str(new_root.resolve())

    def fix(r: dict) -> bool:
        if r.get("scenario") != old:
            return False
        r["scenario"] = to
        cfg = r.get("config") or {}
        if cfg.get("scenario_path") == old_path:
            cfg["scenario_path"] = new_path
        return True

    n = 0
    with _index_lock:
        for p in runs_dir.glob("*/run.json"):
            r = json.loads(p.read_text())
            if fix(r):
                _write_json(p, r)
                n += 1
        idx = runs_dir / "index.json"
        if idx.exists():
            entries = json.loads(idx.read_text())
            for e in entries:
                fix(e)
            _write_json(idx, entries)
    return n


def set_run_label(runs_dir: Path, run_id: str, label: str) -> None:
    """config.label on the run and on its index line ("" removes it)."""
    from tripwire.core.trace import _index_lock

    def apply(r: dict):
        cfg = r.setdefault("config", {})
        if label:
            cfg["label"] = label
        else:
            cfg.pop("label", None)

    with _index_lock:
        p = runs_dir / run_id / "run.json"
        r = json.loads(p.read_text())
        apply(r)
        _write_json(p, r)
        idx = runs_dir / "index.json"
        if idx.exists():
            entries = json.loads(idx.read_text())
            for e in entries:
                if e.get("id") == run_id:
                    apply(e)
            _write_json(idx, entries)


def _write_json(p: Path, x) -> None:
    tmp = p.with_suffix(".edit.tmp")
    tmp.write_text(json.dumps(x, indent=1, default=str))
    tmp.replace(p)


def save_draft(draft: dict, scenarios_dir: Path, overwrite: bool = False, note: str | None = None,
               author: str = "human") -> dict:
    """Write a Draft and record a prompt version if the prompt changed. Raises DraftError, ScenarioExists."""
    name = slugify(draft.get("name") or "")
    existing = scenarios_dir / name
    if (existing / "scenario.yaml").exists():
        if not overwrite:
            raise ScenarioExists(f"scenario {name} already exists")
        if load_scenario(existing).env_kind == "simulated":
            versions.history(existing)  # keep the prompt as it was before this save
    root = write_scenario(draft, scenarios_dir, overwrite=overwrite)
    load_scenario(root)  # prove it loads
    v, _ = versions.record(root, note or "", author)
    return {"name": root.name, "version": v["n"]}


def save_sections(path: Path, sections: dict, note: str | None = None, author: str = "human",
                  renames: dict | None = None) -> dict:
    """Replace a simulated scenario's prompt. -> {name, version, changed}.
    renames {old: new | None}: promises from a renamed part follow it; promises from a removed part (None) become
    about the whole prompt."""
    d = scenario_to_draft(load_scenario(path))
    rules = d["rules"]
    if renames:
        rules = []
        for r in d["rules"]:
            src = r.get("source_section")
            if src in renames:
                r = {k: v for k, v in r.items() if k != "source_section"}
                if renames[src]:
                    r["source_section"] = renames[src]
            rules.append(r)
    versions.history(path)
    write_scenario({**d, "name": path.name, "sections": sections, "rules": rules}, path.parent, overwrite=True)
    load_scenario(path)
    v, changed = versions.record(path, note or "", author)
    return {"name": path.name, "version": versions.meta(v), "changed": changed}


def serve(runs_dir: Path, scenarios_dir: Path, port: int = 8787):
    import uvicorn

    web_dist = Path(__file__).resolve().parents[3] / "web" / "dist"
    uvicorn.run(create_app(runs_dir, scenarios_dir, web_dist), host="127.0.0.1", port=port)
