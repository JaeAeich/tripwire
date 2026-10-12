"""tripwire attribute: which prompt section causes (or prevents) each rule violation.

Method (proven in ContextCite / AttriBoT / Causal Agent Replay): take the cases
that fail, remove one section at a time, replay each variant k times, and
compare per-rule violation rates with the unchanged prompt. We do not ask an
LLM "which line caused this": step-level LLM blame is ~14% accurate (Who&When).

delta = violation_rate(without section) - violation_rate(base)
  delta < 0  -> the section causes violations (culprit)
  delta > 0  -> the section prevents violations (load-bearing)
"""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from tripwire import versions
from tripwire.core import stats
from tripwire.core.backends import Backend
from tripwire.core.runner import Job, Models, run_jobs
from tripwire.core.scenario import Scenario
from tripwire.core.trace import Run


def _cells(trials) -> dict[str, dict[str, tuple[int, int]]]:
    """rule -> case -> (violated, checked)."""
    out: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for t in trials:
        if t.error:  # crashed trials say nothing about the prompt
            continue
        for rule in {v.rule for v in t.verdicts if not v.error}:
            cell = out[rule][t.case_id]
            cell[1] += 1
            if any(not v.passed for v in t.verdicts if v.rule == rule and not v.error):
                cell[0] += 1
    return {r: {c: (v, n) for c, (v, n) in cs.items()} for r, cs in out.items()}


def _rates(trials) -> dict[str, tuple[int, int]]:
    return {r: (sum(v for v, _ in cs.values()), sum(n for _, n in cs.values()))
            for r, cs in _cells(trials).items()}


def summarize(run: Run) -> dict:
    """delta/ci: pooled rates (kept for old readers). lo/hi/significant: paired over cases
    (same case in base and ablated variant), Holm-corrected across all (section, rule) cells."""
    by_variant: dict[str, list] = defaultdict(list)
    for t in run.trials:
        by_variant[t.variant].append(t)
    base_cells = _cells(by_variant.get("base", []))
    base = _rates(by_variant.get("base", []))
    matrix = []
    for variant, trials in sorted(by_variant.items()):
        if variant == "base":
            continue
        section = variant.split(":", 1)[1]
        for rule, cs in sorted(_cells(trials).items()):
            v1, n1 = sum(v for v, _ in cs.values()), sum(n for _, n in cs.values())
            v0, n0 = base.get(rule, (0, 0))
            if not n0 or not n1:
                continue
            d = v1 / n1 - v0 / n0
            b = base_cells.get(rule, {})
            pd = stats.paired_diff([(b[c], cs[c]) for c in sorted(cs) if c in b])
            matrix.append({"section": section, "rule": rule, "base_rate": round(v0 / n0, 3),
                           "ablated_rate": round(v1 / n1, 3), "delta": round(d, 3),
                           "ci": [round(pd["lo"], 3), round(pd["hi"], 3)],
                           "lo": round(pd["lo"], 3), "hi": round(pd["hi"], 3), "p": round(pd["p"], 4),
                           "cases": pd["cases"], "n": [n0, n1]})
    _, sig = stats.holm([m["p"] for m in matrix])
    for m, s in zip(matrix, sig):
        m["significant"] = s
        m["role"] = "culprit" if m["hi"] < 0 else "load-bearing" if m["lo"] > 0 else "unclear"
        m["sentence"] = stats.ablation_sentence(m["section"], m["rule"], m["base_rate"], m["ablated_rate"],
                                                m["lo"], m["hi"], s)
    culprits = sorted((m for m in matrix if m["role"] == "culprit"), key=lambda m: m["delta"])
    holding = sorted((m for m in matrix if m["role"] == "load-bearing"), key=lambda m: -m["delta"])
    return {
        "headline": {"done": len(run.trials), "culprits": len(culprits), "load_bearing": len(holding),
                     "top": _sentence(culprits[0] if culprits else holding[0]) if culprits or holding else None},
        "k": run.config.get("k"),
        "done": len(run.trials),
        "cost_usd": round(sum(t.cost_usd for t in run.trials), 4),
        "base_rates": {r: {"violated": v, "checked": n} for r, (v, n) in sorted(base.items())},
        "matrix": matrix,
        "culprits": culprits,
    }


def _sentence(m: dict) -> str:
    return m["sentence"]


def run_attribution(scn: Scenario, base_run: dict, backend: Backend, runs_dir: Path, k: int = 5,
                    sections: list[str] | None = None, case_ids: list[str] | None = None,
                    models: Models | None = None, workers: int = 4, on_progress=None,
                    run: Run | None = None, **run_opts) -> Run:
    """run_opts go to run_jobs: trial_timeout_s, trial_retries, stop."""
    prompt = base_run["config"].get("prompt") or scn.sections
    if not case_ids:
        per_case = base_run["summary"].get("per_case", {})
        case_ids = [cid for cid, c in per_case.items() if c["pass_rate"] < 1]
    if not case_ids:
        raise ValueError("no failing cases in the base run; nothing to attribute")
    targets = sections or [s for s in prompt if s != "preamble"]
    models = models or Models(**base_run["config"]["models"])
    run = run or Run.new("attribute", scn.name, {})
    run.config.update({"k": k, "base_run": base_run["id"], "cases": case_ids, "sections": targets,
                       "backend": backend.name, "models": vars(models), "prompt": prompt,
                       "scenario_path": str(scn.root),
                       "prompt_version": base_run["config"].get("prompt_version") or versions.version_of(scn, prompt)})
    cases = [scn.case(c) for c in case_ids]
    jobs = [Job(c, i, "base", prompt) for c in cases for i in range(k)]
    for s in targets:
        variant = {n: t for n, t in prompt.items() if n != s}
        jobs += [Job(c, i, f"ablate:{s}", variant) for c in cases for i in range(k)]
    return run_jobs(scn, run, jobs, models, backend, runs_dir, workers, True, summarize, on_progress, **run_opts)
