"""The trace format. Every command writes it and the UI only reads it.

Run -> Trial -> Turn / Verdict. Kept as plain dataclasses that serialise to
JSON so other tools (and the web UI) never import Python.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

SCHEMA_VERSION = 1


@dataclass
class ToolCall:
    name: str
    args: dict[str, Any]
    result: Any
    blocked: bool = False  # the environment refused (guard, error, not found)


@dataclass
class Turn:
    role: Literal["user", "agent", "tool"]
    text: str | None = None
    tool_call: ToolCall | None = None
    t: float = 0.0  # seconds since trial start


@dataclass
class Verdict:
    rule: str
    check: str
    passed: bool
    grader: Literal["state", "trajectory", "text", "judge"]
    detail: str = ""
    step: int | None = None  # turn index the failure points at, if known
    error: bool = False  # the check itself couldn't run; not counted as pass or fail


@dataclass
class Trial:
    case_id: str
    trial: int
    variant: str = "base"  # "base" or "ablate:<section>"
    turns: list[Turn] = field(default_factory=list)
    verdicts: list[Verdict] = field(default_factory=list)
    passed: bool = False
    state_diff: list[dict] = field(default_factory=list)
    cost_usd: float = 0.0
    latency_s: float = 0.0
    error: str | None = None
    retries: int = 0  # whole-trial reruns after an infra error (timeout, backend failure)
    protocol_retries: int = 0  # model steps redone because the model tried to call a tool natively


@dataclass
class Run:
    id: str
    kind: Literal["eval", "attribute", "attack"]
    scenario: str
    created: float
    config: dict[str, Any] = field(default_factory=dict)
    trials: list[Trial] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)
    status: Literal["running", "done", "failed", "stopped"] = "running"
    schema: int = SCHEMA_VERSION
    # trials in flight right now, so the UI can show what is happening. Empty when finished.
    # {key, case_id, variant, trial, attempt, started, phase: customer|agent|grading, turns: [Turn]}
    live: list[dict[str, Any]] = field(default_factory=list)
    updated: float = 0.0  # last save; a "running" run that stops updating is dead

    @staticmethod
    def new(kind: str, scenario: str, config: dict) -> "Run":
        stamp = time.strftime("%Y%m%d-%H%M%S")
        return Run(id=f"{stamp}-{kind}-{uuid.uuid4().hex[:4]}", kind=kind, scenario=scenario,
                   created=time.time(), config=config)

    def to_dict(self) -> dict:
        return asdict(self)

    def save(self, runs_dir: Path) -> Path:
        out = runs_dir / self.id
        out.mkdir(parents=True, exist_ok=True)
        path = out / "run.json"
        self.updated = time.time()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.to_dict(), indent=1, default=str))
        tmp.replace(path)
        _update_index(runs_dir, self)
        return path


_index_lock = threading.Lock()


def _update_index(runs_dir: Path, run: Run) -> None:
    """runs/index.json: one line per run so the UI can list runs cheaply."""
    with _index_lock:
        _write_index(runs_dir, run)


def _write_index(runs_dir: Path, run: Run) -> None:
    idx_path = runs_dir / "index.json"
    idx = json.loads(idx_path.read_text()) if idx_path.exists() else []
    entry = {"id": run.id, "kind": run.kind, "scenario": run.scenario, "created": run.created,
             "updated": run.updated, "status": run.status, "config": run.config,
             "headline": {**{k: run.summary.get(k) for k in ("pass_at_1", "pass_hat_k", "k", "trials", "cost_usd")},
                          **run.summary.get("headline", {})}}
    idx = [e for e in idx if e["id"] != run.id] + [entry]
    idx.sort(key=lambda e: e["created"], reverse=True)
    tmp = idx_path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(idx, indent=1))
    tmp.replace(idx_path)


def load_run(path: Path) -> dict:
    return json.loads(path.read_text())


def run_from_dict(d: dict) -> Run:
    def trial(t: dict) -> Trial:
        turns = [Turn(**{**u, "tool_call": ToolCall(**u["tool_call"]) if u.get("tool_call") else None})
                 for u in t.get("turns", [])]
        # runs before 2026-10-16 marked a broken check only in its detail
        verdicts = [Verdict(**{"error": str(v.get("detail", "")).startswith("check error:"), **v})
                    for v in t.get("verdicts", [])]
        return Trial(**{**t, "turns": turns, "verdicts": verdicts})
    return Run(**{**d, "trials": [trial(t) for t in d.get("trials", [])]})
