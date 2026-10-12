"""tripwire eval: pass@1 and pass^k, per case and per policy rule."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from tripwire import versions
from tripwire.core import stats
from tripwire.core.backends import Backend
from tripwire.core.runner import Job, Models, run_jobs
from tripwire.core.scenario import Scenario, case_hash
from tripwire.core.trace import Run


def summarize(run: Run, variant: str = "base") -> dict:
    all_trials = [t for t in run.trials if t.variant == variant]
    # trials that crashed (rate limit, timeout, backend error) say nothing about the prompt: leave them out
    trials = [t for t in all_trials if not t.error]
    by_case: dict[str, list] = defaultdict(list)
    for t in trials:
        by_case[t.case_id].append(t)
    per_case = {
        cid: {"passes": [t.passed for t in sorted(ts, key=lambda x: x.trial)],
              "pass_rate": sum(t.passed for t in ts) / len(ts)}
        for cid, ts in sorted(by_case.items())
    }
    per_rule: dict[str, dict] = defaultdict(lambda: {"checked": 0, "violated": 0})
    rule_cells: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for t in trials:
        for rule in {v.rule for v in t.verdicts if not v.error}:
            bad = any(not v.passed for v in t.verdicts if v.rule == rule and not v.error)
            per_rule[rule]["checked"] += 1
            per_rule[rule]["violated"] += bad
            cell = rule_cells[rule][t.case_id]
            cell[0] += bad
            cell[1] += 1
    for rule, r in per_rule.items():
        r["rate"] = r["violated"] / r["checked"] if r["checked"] else 0.0
        cr = stats.clustered_rate(list(rule_cells[rule].values()))
        r["cases"] = cr["cases"]
        r["lo"], r["hi"] = round(cr["lo"], 3), round(cr["hi"], 3)
        r["verdict"] = stats.rule_verdict(r["violated"], r["checked"], r["cases"], cr["lo"], cr["hi"])
        r["sentence"] = stats.rule_sentence(r["violated"], r["checked"], r["cases"], cr["lo"], cr["hi"],
                                            r["verdict"])
    worst = max(per_rule.items(), key=lambda kv: kv[1]["rate"], default=None)
    k = run.config.get("k", 1)
    cells = [(sum(c["passes"]), len(c["passes"])) for c in per_case.values()]
    p1 = stats.clustered_rate(cells)
    phk = stats.pass_hat_k(cells, k)
    return {
        "k": k,
        "trials": len(trials),
        "done": len(run.trials),
        "pass_at_1": (sum(t.passed for t in trials) / len(trials)) if trials else None,
        "pass_at_1_ci": [round(p1["lo"], 3), round(p1["hi"], 3)] if trials else None,
        # unbiased C(c,k)/C(n,k) per case, averaged over cases with >= k trials
        "pass_hat_k": phk["mean"],
        "pass_hat_k_ci": [round(phk["lo"], 3), round(phk["hi"], 3)] if phk["cases"] else None,
        "min_detectable_effect": stats.min_detectable_effect(len(cells), k, stats.within_case_var(cells)),
        "cost_usd": round(sum(t.cost_usd for t in run.trials), 4),
        "errors": sum(1 for t in all_trials if t.error),  # not counted in any rate above
        "check_errors": sum(1 for t in trials for v in t.verdicts if v.error),
        "per_case": per_case,
        "per_rule": dict(sorted(per_rule.items())),
        "headline": {"done": len(run.trials),
                     "worst_rule": ({"rule": worst[0], "rate": worst[1]["rate"]}
                                    if worst and worst[1]["violated"] else None)},
    }


def run_eval(scn: Scenario, backend: Backend, runs_dir: Path, k: int = 3, case_ids: list[str] | None = None,
             models: Models | None = None, workers: int = 4, use_judge: bool = True,
             sections: dict[str, str] | None = None, on_progress=None, run: Run | None = None,
             **run_opts) -> Run:
    """run_opts go to run_jobs: trial_timeout_s, trial_retries, stop."""
    models = models or Models.from_scenario(scn)
    cases = [c for c in scn.cases if not case_ids or c["id"] in case_ids]
    run = run or Run.new("eval", scn.name, {})
    run.config.update({"k": k, "backend": backend.name, "models": vars(models), "cases": [c["id"] for c in cases],
                       "judge": use_judge, "sections": list((sections or scn.sections).keys())})
    run.config["prompt"] = sections or scn.sections
    run.config["scenario_path"] = str(scn.root)
    run.config["case_hashes"] = {c["id"]: case_hash(c) for c in cases}  # so the UI can tell a test changed since
    if run.config.get("prompt_version") is None:
        run.config["prompt_version"] = versions.version_of(scn, sections or scn.sections)
    jobs = [Job(c, i, "base", sections or scn.sections) for c in cases for i in range(k)]
    return run_jobs(scn, run, jobs, models, backend, runs_dir, workers, use_judge, summarize, on_progress, **run_opts)
