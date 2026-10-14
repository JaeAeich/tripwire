"""`tripwire mcp`: the improve loop as MCP tools, so a coding agent can fix a prompt the way a human
does in the UI: brief -> edit -> save version -> rerun affected promises -> compare.

Newline-delimited JSON-RPC 2.0 on stdio (same subset as core/mcp_bridge.py: initialize, ping,
tools/list, tools/call). Checks run in background threads of this process; ending the session
stops them (finished trials are kept, status "stopped"). docs/AGENTS.md has the setup.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

from tripwire import loop, versions
from tripwire.core.runner import stop_run
from tripwire.core.scenario import load_scenario

S, I, N, B = {"type": "string"}, {"type": "integer"}, {"type": "number"}, {"type": "boolean"}
RULES = {"type": "array", "items": S, "description": "promise ids, e.g. [\"R3\"]; omit for all"}


def _tool(name, description, props=None, required=()):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": props or {}, "required": list(required)}}


TOOLS = [
    _tool("list_projects", "Scenarios (projects) with their promises and latest runs."),
    _tool("get_report", "Plain report of one run: per promise verdict and sentence, pass rate, cost.",
          {"run": S}, ["run"]),
    _tool("get_brief", "Evidence for fixing the prompt: failing promises, their source section, the map "
          "(which section holds or breaks them), failing conversation excerpts, and promises that must not "
          "regress. Markdown by default.",
          {"run": S, "rule": S, "section": S, "format": {"type": "string", "enum": ["md", "json"]}}, ["run"]),
    _tool("get_prompt", "Prompt sections of a project (latest version, or `version`), with its promises "
          "and version history.", {"project": S, "version": I}, ["project"]),
    _tool("save_prompt_version", "Save new prompt sections as a new version (author 'agent'). Pass ALL "
          "sections (name -> text), in order; edit as few as possible.",
          {"project": S, "sections": {"type": "object", "additionalProperties": S}, "note": S},
          ["project", "sections", "note"]),
    _tool("estimate_check", "Trials and estimated cost of a check (only cases checking `rules`, if given).",
          {"project": S, "rules": RULES, "k": I}, ["project"]),
    _tool("run_check", "Start a check of the latest (or given) prompt version in the background; refuses if "
          "the estimate exceeds max_cost_usd. Returns the run id; poll get_run_status.",
          {"project": S, "rules": RULES, "k": I, "max_cost_usd": N, "prompt_version": I, "judge": B},
          ["project", "max_cost_usd"]),
    _tool("get_run_status", "Status and progress of a run.", {"run": S}, ["run"]),
    _tool("compare_runs", "Per promise before (a) vs after (b): fixed | regressed | same | new | not_rerun.",
          {"a": S, "b": S}, ["a", "b"]),
]


class ToolError(Exception):
    pass


class Server:
    def __init__(self, runs_dir: Path, scenarios_dir: Path, backend=None):
        self.runs_dir, self.scenarios_dir = Path(runs_dir), Path(scenarios_dir)
        self._backend = backend
        self.started: list[str] = []
        self.lock = threading.Lock()

    @property
    def backend(self):
        if self._backend is None:
            from tripwire.core.backends import get_backend
            self._backend = get_backend()
        return self._backend

    def _scenario(self, name: str):
        p = self.scenarios_dir / str(name)
        if not (p / "scenario.yaml").exists():
            raise ToolError(f"unknown project {name!r}; see list_projects")
        return load_scenario(p)

    def _run(self, run_id: str) -> dict:
        p = self.runs_dir / str(run_id) / "run.json"
        if not p.exists():
            raise ToolError(f"run {run_id!r} not found")
        return json.loads(p.read_text())

    def _index(self) -> list[dict]:
        p = self.runs_dir / "index.json"
        return json.loads(p.read_text()) if p.exists() else []

    # ---- tools

    def list_projects(self):
        idx = self._index()
        out = []
        for p in sorted(self.scenarios_dir.glob("*/scenario.yaml")):
            s = load_scenario(p.parent)
            runs = [{"id": e["id"], "kind": e["kind"], "status": e["status"],
                     "prompt_version": (e.get("config") or {}).get("prompt_version"),
                     "pass_at_1": (e.get("headline") or {}).get("pass_at_1")}
                    for e in idx if e["scenario"] == s.name][:5]
            out.append({"project": p.parent.name, "title": s.title, "description": s.description, "editable": s.env_kind == "simulated",
                        "promises": [{"id": r["id"], "title": r.get("title")} for r in s.rules.values()],
                        "cases": len(s.cases), "latest_runs": runs})
        return out

    def get_report(self, run):
        r = self._run(run)
        from tripwire.compare import rule_table
        s, cfg = r.get("summary") or {}, r.get("config") or {}
        return {"id": r["id"], "kind": r["kind"], "project": r["scenario"], "status": r["status"],
                "prompt_version": cfg.get("prompt_version"), "k": cfg.get("k"), "rules_filter": cfg.get("rules"),
                "pass_at_1": s.get("pass_at_1"), "pass_at_1_ci": s.get("pass_at_1_ci"),
                "pass_hat_k": s.get("pass_hat_k"), "trials": s.get("trials"), "errors": s.get("errors"),
                "cost_usd": s.get("cost_usd"), "error": s.get("error"),
                "per_promise": {k: {x: v[x] for x in ("verdict", "sentence", "violated", "checked")}
                                for k, v in rule_table(r).items()}}

    def get_brief(self, run, rule=None, section=None, format="md"):
        from tripwire.brief import build
        b = build(self._run(run), rule=rule, section=section, runs_dir=self.runs_dir)
        return b["markdown"] if format != "json" else b

    def get_prompt(self, project, version=None):
        scn = self._scenario(project)
        rules = [{k: r.get(k) for k in ("id", "title", "text", "source_section")} for r in scn.rules.values()]
        if scn.env_kind != "simulated":
            return {"project": project, "version": None, "editable": False, "sections": scn.sections, "rules": rules}
        v = versions.get(scn.root, version)
        if v is None:
            raise ToolError(f"no version {version}")
        return {"project": project, "version": v["n"], "editable": True, "sections": v["sections"], "rules": rules,
                "versions": [versions.meta(x) for x in versions.history(scn.root)]}

    def save_prompt_version(self, project, sections, note):
        from tripwire.draft import DraftError
        from tripwire.server import save_sections
        scn = self._scenario(project)
        if scn.env_kind != "simulated":
            raise ToolError("only simulated projects can be edited")
        if not isinstance(sections, dict) or not all(isinstance(v, str) for v in sections.values()):
            raise ToolError("sections must be an object of section name -> text")
        with self.lock:
            try:
                return save_sections(scn.root, sections, note, "agent")
            except DraftError as e:
                raise ToolError("prompt rejected: " + "; ".join(e.problems))

    def estimate_check(self, project, rules=None, k=3):
        try:
            return loop.estimate(self._scenario(project), self.runs_dir, rules, int(k))
        except ValueError as e:
            raise ToolError(str(e))

    def run_check(self, project, max_cost_usd, rules=None, k=3, prompt_version=None, judge=True):
        scn = self._scenario(project)
        est = self.estimate_check(project, rules, k)
        if est["est_cost_usd"] > float(max_cost_usd):
            raise ToolError(f"refused: estimated ${est['est_cost_usd']:.3f} for {est['trials']} trials is over "
                            f"max_cost_usd ${float(max_cost_usd):.3f}; lower k, pass fewer rules, or raise the limit")
        try:
            run = loop.start_check(scn, self.backend, self.runs_dir, k=int(k), rules=rules,
                                   prompt_version=prompt_version, judge=judge)
        except ValueError as e:
            raise ToolError(str(e))
        self.started.append(run.id)
        return {"run": run.id, "prompt_version": run.config.get("prompt_version"), "estimate": est}

    def get_run_status(self, run):
        r = self._run(run)
        s, cfg = r.get("summary") or {}, r.get("config") or {}
        return {"id": r["id"], "status": r["status"], "done": len(r.get("trials", [])),
                "total": cfg.get("total_trials"), "cost_usd": s.get("cost_usd"), "pass_at_1": s.get("pass_at_1"),
                "error": s.get("error"), "updated": r.get("updated")}

    def compare_runs(self, a, b):
        from tripwire.compare import compare
        ra, rb = self._run(a), self._run(b)
        if ra["scenario"] != rb["scenario"]:
            raise ToolError("runs are of different projects")
        return compare(ra, rb)

    # ---- protocol

    def call(self, name: str, args: dict) -> dict:
        if name not in {t["name"] for t in TOOLS}:
            return _text(f"unknown tool {name}", True)
        try:
            out = getattr(self, name)(**args)
        except ToolError as e:
            return _text(str(e), True)
        except TypeError as e:  # wrong / missing arguments
            return _text(f"bad arguments: {e}", True)
        except Exception as e:  # noqa: BLE001 - report, don't kill the server
            return _text(f"{type(e).__name__}: {e}", True)
        return _text(out if isinstance(out, str) else json.dumps(out, indent=1, default=str))

    def handle(self, msg: dict) -> dict | None:
        method, msg_id, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
        if msg_id is None:  # notification
            return None
        if method == "initialize":
            res = {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                   "capabilities": {"tools": {"listChanged": False}},
                   "serverInfo": {"name": "tripwire", "version": "1"}}
        elif method == "ping":
            res = {}
        elif method == "tools/list":
            res = {"tools": TOOLS}
        elif method == "tools/call":
            res = self.call(params.get("name"), params.get("arguments") or {})
        elif method in ("resources/list", "prompts/list"):
            res = {method.split("/")[0]: []}
        else:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"method not found: {method}"}}
        return {"jsonrpc": "2.0", "id": msg_id, "result": res}

    def serve(self, stdin=None, stdout=None) -> None:
        stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
        for line in stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
            else:
                out = self.handle(msg)
            if out is not None:
                stdout.write(json.dumps(out) + "\n")
                stdout.flush()
        self.shutdown()

    def shutdown(self, wait_s: float = 5) -> None:
        """Stop checks still running in this process, so they end as "stopped", not dead "running"."""
        live = [r for r in self.started if stop_run(r)]
        end = time.time() + wait_s
        while live and time.time() < end:
            live = [r for r in live if self._run(r)["status"] == "running"]
            time.sleep(0.1)


def _text(s: str, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": s}], "isError": error}
