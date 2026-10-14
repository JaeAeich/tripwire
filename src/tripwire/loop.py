"""The improve loop shared by the HTTP API and the MCP server: which cases a rerun needs,
what it will cost, and starting a check in the background."""

from __future__ import annotations

import json
import statistics
import threading
from pathlib import Path

from tripwire import versions
from tripwire.core.runner import Models
from tripwire.core.scenario import Scenario
from tripwire.core.trace import Run

DEFAULT_TRIAL_COST_USD = 0.012  # one conversation incl. simulated tools + Sonnet judge (JOURNEY.md: $0.82 / 72)


def affected_cases(scn: Scenario, rules: list[str] | None = None, cases: list[str] | None = None) -> list[str]:
    """Case ids with a check on any of `rules` (all cases if no rules), limited to `cases` if given."""
    bad = [r for r in rules or [] if r not in scn.rules]
    if bad:
        raise ValueError(f"unknown rule(s): {', '.join(bad)}")
    return [c["id"] for c in scn.cases if (not cases or c["id"] in cases)
            and (not rules or any(ch.get("rule") in rules for ch in c.get("checks", [])))]


def trial_cost(runs_dir: Path, scenario: str) -> tuple[float, str]:
    """Median cost per trial of the last finished eval runs of this scenario, else a default."""
    idx = Path(runs_dir) / "index.json"
    seen = []
    for e in json.loads(idx.read_text()) if idx.exists() else []:
        h = e.get("headline") or {}
        if e["scenario"] == scenario and e["kind"] == "eval" and e["status"] == "done" and h.get("trials"):
            seen.append((h.get("cost_usd") or 0) / h["trials"])
    seen = [c for c in seen[:5] if c > 0]
    return (statistics.median(seen), "past runs") if seen else (DEFAULT_TRIAL_COST_USD, "default")


def estimate(scn: Scenario, runs_dir: Path, rules: list[str] | None = None, k: int = 3,
             cases: list[str] | None = None) -> dict:
    ids = affected_cases(scn, rules, cases)
    per, basis = trial_cost(runs_dir, scn.name)
    return {"cases": ids, "trials": len(ids) * k, "per_trial_usd": round(per, 4),
            "est_cost_usd": round(len(ids) * k * per, 3), "basis": basis}


def resolve_prompt(scn: Scenario, prompt_version: int | None) -> tuple[dict[str, str], int | None]:
    """-> (sections, version number). Python scenarios have no history: (scn.sections, None)."""
    if scn.env_kind != "simulated":
        if prompt_version is not None:
            raise ValueError("only simulated scenarios have prompt versions")
        return scn.sections, None
    v = versions.get(scn.root, prompt_version)
    if v is None:
        raise ValueError(f"no prompt version {prompt_version}")
    return v["sections"], v["n"]


def start_check(scn: Scenario, backend, runs_dir: Path, k: int = 3, rules: list[str] | None = None,
                cases: list[str] | None = None, prompt_version: int | None = None, judge: bool = True,
                agent_model: str | None = None, workers: int = 4, trial_timeout_s: float | None = 600) -> Run:
    """Eval run in a background thread. Raises ValueError for bad input (before anything starts)."""
    ids = affected_cases(scn, rules, cases)
    if not ids:
        raise ValueError("no cases check " + (", ".join(rules) if rules else "anything"))
    sections, n = resolve_prompt(scn, prompt_version)
    run = Run.new("eval", scn.name, {"rules": rules, "prompt_version": n})

    def work():
        from tripwire.eval import run_eval
        models = Models.from_scenario(scn, agent=agent_model)
        guard(run, runs_dir, lambda: run_eval(scn, backend, runs_dir, k=k, case_ids=ids, models=models,
                                              workers=workers, use_judge=judge, sections=sections, run=run,
                                              trial_timeout_s=trial_timeout_s))
    run.save(runs_dir)
    threading.Thread(target=work, daemon=True).start()
    return run


def guard(run: Run, runs_dir: Path, fn):
    try:
        fn()
    except Exception as e:  # surface failures in the UI instead of a dead "running" run
        run.status = "failed"
        run.summary["error"] = f"{type(e).__name__}: {e}"
        run.save(runs_dir)
