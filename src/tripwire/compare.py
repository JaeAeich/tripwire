"""Before/after per promise for two runs of the same scenario (e.g. prompt v2 vs v3).

Paired by case where both runs ran it (stats.paired_diff over cases, after - before violation rate);
falls back to the two separate intervals when no case is shared.
  fixed:     violations went down (95% interval below 0)
  regressed: violations went up (interval above 0)
  same:      can't tell a difference (`leaning` says which way the point estimate moved)
  new:       only the after run checked this promise
  not_rerun: only the before run checked it (a rerun limited to some promises)
"""

from __future__ import annotations

from collections import defaultdict

from tripwire.core import stats


def variant_of(run: dict) -> str:
    return "attack" if run.get("kind") == "attack" else "base"


def rule_cells(run: dict) -> dict[str, dict[str, tuple[int, int]]]:
    """rule -> case -> (violated, checked) over the run's main variant; crashed trials and broken checks left out."""
    out: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for t in run.get("trials", []):
        if t.get("error") or t.get("variant", "base") != variant_of(run):
            continue
        vs = [v for v in t.get("verdicts", []) if not v.get("error")]
        for rule in {v["rule"] for v in vs}:
            cell = out[rule][t["case_id"]]
            cell[0] += any(not v["passed"] for v in vs if v["rule"] == rule)
            cell[1] += 1
    return {r: {c: (v, n) for c, (v, n) in cs.items()} for r, cs in sorted(out.items())}


def rule_table(run: dict) -> dict[str, dict]:
    """Per promise: violated, checked, cases, rate, lo, hi, verdict, sentence."""
    out = {}
    for rule, cs in rule_cells(run).items():
        v, n = sum(a for a, _ in cs.values()), sum(b for _, b in cs.values())
        cr = stats.clustered_rate(list(cs.values()))
        verdict = stats.rule_verdict(v, n, cr["cases"], cr["lo"], cr["hi"])
        out[rule] = {"violated": v, "checked": n, "cases": cr["cases"], "rate": round(v / n, 3) if n else None,
                     "lo": round(cr["lo"], 3), "hi": round(cr["hi"], 3), "verdict": verdict,
                     "sentence": stats.rule_sentence(v, n, cr["cases"], cr["lo"], cr["hi"], verdict)}
    return out


def compare(a: dict, b: dict) -> dict:
    ca, cb = rule_cells(a), rule_cells(b)
    ta, tb = rule_table(a), rule_table(b)
    per_rule = {}
    for rule in sorted(set(ca) | set(cb)):
        before, after = ta.get(rule), tb.get(rule)
        row = {"before": before, "after": after}
        if not after:
            row.update(change="not_rerun", sentence=f"{rule} wasn't checked in the second run")
        elif not before:
            row.update(change="new", sentence=f"{rule} wasn't checked in the first run; now: {after['sentence']}")
        else:
            shared = sorted(set(ca[rule]) & set(cb[rule]))
            if shared:
                pd = stats.paired_diff([(ca[rule][c], cb[rule][c]) for c in shared])
                d, lo, hi = pd["delta"], pd["lo"], pd["hi"]
            else:  # no common case: only clearly separated intervals count
                d = after["rate"] - before["rate"]
                lo, hi = after["lo"] - before["hi"], after["hi"] - before["lo"]
            change = "fixed" if hi < 0 else "regressed" if lo > 0 else "same"
            row.update(change=change, delta=round(d, 3), lo=round(lo, 3), hi=round(hi, 3), paired_cases=len(shared),
                       leaning=None if change != "same" or round(100 * d) == 0 else "better" if d < 0 else "worse",
                       sentence=_sentence(rule, before, after, change, d, lo, hi, len(shared)))
        per_rule[rule] = row
    by = lambda ch: [r for r, x in per_rule.items() if x["change"] == ch]  # noqa: E731
    pv = [(r.get("config") or {}).get("prompt_version") for r in (a, b)]
    head = (f"{len(by('fixed'))} fixed, {len(by('regressed'))} regressed, {len(by('same'))} no clear change"
            + (f", {len(by('new'))} new" if by("new") else ""))
    return {"a": a["id"], "b": b["id"], "scenario": b.get("scenario"), "prompt_versions": pv,
            "per_rule": per_rule, "fixed": by("fixed"), "regressed": by("regressed"), "same": by("same"),
            "new": by("new"), "not_rerun": by("not_rerun"), "sentence": head}


def _sentence(rule, before, after, change, d, lo, hi, paired) -> str:
    move = f"{rule} failures {stats.pct(before['rate'])} -> {stats.pct(after['rate'])}"
    ci = f"likely {stats.pts(lo)} to {stats.pts(hi)} pts" + (f", {stats.plural(paired, 'shared conversation')}"
                                                             if paired else ", no shared conversations")
    tail = {"fixed": "fixed", "regressed": "regressed"}.get(change, "can't tell a difference yet")
    return f"{move} ({ci}): {tail}"
