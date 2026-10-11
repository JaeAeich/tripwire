"""Small-sample statistics for tripwire, in pure Python.

Our data: few cases (conversations) per rule, k = 3-8 trials per case. Trials of
one case are not independent (same persona, same trap), so the unit is the case.
Everything here is deterministic (fixed seeds) so a summary never changes when
recomputed from the same trials.

See docs/notes/measurement.md for sources.
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence

Z95 = 1.959963984540054
Z80_POWER = 0.8416212335729143
BOOT = 4000  # enough resamples that Holm across ~30 cells can still reach p < 0.05/30
SEED = 1729


# ---------- single rates ----------

def wilson(x: float, n: float, z: float = Z95) -> tuple[float, float]:
    """Wilson score interval for x successes in n trials (x may be fractional).

    Unlike the normal (Wald) interval it does not collapse at 0% or 100% and
    keeps sensible coverage for n < 30.
    """
    if n <= 0:
        return 0.0, 1.0
    p = min(max(x / n, 0.0), 1.0)
    z2 = z * z
    den = 1 + z2 / n
    mid = (p + z2 / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den
    return max(0.0, mid - half), min(1.0, mid + half)


def clustered_rate(cells: Sequence[tuple[float, int]], z: float = Z95) -> dict:
    """Rate and 95% interval when trials are clustered in cases.

    cells: one (events, trials) pair per case.

    Method: Wilson interval on the pooled rate, using an effective sample size
    n_eff = p(1-p) / Var_cluster(p), where Var_cluster is the cluster-robust
    (ratio-estimator) variance over cases (Miller 2411.00640). n_eff is clamped
    to [cases, trials]: at worst every trial of a case is a copy (n = cases), at
    best trials are independent (n = trials).

    Why not a cluster bootstrap: with 1-3 cases, or when every case is 0% or
    100%, a bootstrap over cases collapses to a zero-width interval and claims
    certainty it does not have. Wilson never collapses. When the between-case
    variance cannot be estimated (1 case, or p at 0/1) we use n = trials; the
    verdict layer flags those as too little data where it matters.
    """
    cells = [(float(v), int(n)) for v, n in cells if n > 0]
    c = len(cells)
    total = sum(n for _, n in cells)
    if not total:
        return {"rate": None, "lo": 0.0, "hi": 1.0, "cases": 0, "n": 0, "n_eff": 0.0}
    events = sum(v for v, _ in cells)
    p = events / total
    n_eff = float(total)
    if c >= 2 and 0 < p < 1:
        var = c / (c - 1) * sum((v - p * n) ** 2 for v, n in cells) / total ** 2
        if var > 0:
            n_eff = min(max(p * (1 - p) / var, c), total)
    lo, hi = wilson(p * n_eff, n_eff, z)
    return {"rate": p, "lo": lo, "hi": hi, "cases": c, "n": total, "n_eff": n_eff}


# ---------- pass^k / pass@k ----------

def pass_hat_k_case(c: int, n: int, k: int) -> float:
    """Unbiased per-case pass^k: chance k fresh trials all pass = C(c,k)/C(n,k).

    With n == k this is all(passes). Needs n >= k.
    """
    if n < k:
        raise ValueError(f"need n >= k (n={n}, k={k})")
    return math.comb(c, k) / math.comb(n, k)


def pass_at_k_case(c: int, n: int, k: int) -> float:
    """Unbiased per-case pass@k = 1 - C(n-c,k)/C(n,k)."""
    if n < k:
        raise ValueError(f"need n >= k (n={n}, k={k})")
    return 1 - math.comb(n - c, k) / math.comb(n, k)


def mean_ci_over_cases(values: Sequence[float], boot: int = BOOT, seed: int = SEED,
                       z: float = Z95) -> dict:
    """Mean of per-case values in [0, 1] with a 95% interval.

    Percentile bootstrap over cases, widened to at least the Wilson interval on
    (sum, cases). A [0, 1] variable with mean p has variance <= p(1-p), so
    Wilson with n = cases is a conservative floor that keeps the interval open
    when all cases agree (where the bootstrap would collapse to a point).
    """
    vals = list(values)
    c = len(vals)
    if not c:
        return {"mean": None, "lo": 0.0, "hi": 1.0, "cases": 0}
    m = sum(vals) / c
    rng = random.Random(seed)
    draws = sorted(sum(vals[rng.randrange(c)] for _ in range(c)) / c for _ in range(boot))
    blo, bhi = _pct(draws, 0.025), _pct(draws, 0.975)
    wlo, whi = wilson(sum(vals), c, z)
    return {"mean": m, "lo": min(blo, wlo), "hi": max(bhi, whi), "cases": c}


def pass_hat_k(cells: Sequence[tuple[int, int]], k: int, **kw) -> dict:
    """pass^k over cases. cells: (passes, trials) per case; cases with < k trials are skipped."""
    return mean_ci_over_cases([pass_hat_k_case(c, n, k) for c, n in cells if n >= k], **kw)


# ---------- paired comparisons ----------

def paired_diff(pairs: Sequence[tuple[tuple[int, int], tuple[int, int]]], boot: int = BOOT,
                seed: int = SEED) -> dict:
    """Paired difference of rates over cases: variant - base.

    pairs: per case ((v_base, n_base), (v_variant, n_variant)), same cases on both sides.
    Point estimate: mean over cases of (v1/n1 - v0/n0).
    Interval: two-level bootstrap. Resample cases with replacement (the unit),
    then draw each case's rates from its Jeffreys posterior Beta(v+.5, n-v+.5)
    so within-case trial noise stays in even with 1 case or 0/4-vs-0/4 cells
    (a plain case bootstrap would give a zero-width interval there). The
    interval is stretched to contain the point estimate (Jeffreys draws shrink
    toward 50%). p: two-sided bootstrap tail probability that the true
    difference is on the other side of 0.
    """
    pairs = [(b, v) for b, v in pairs if b[1] > 0 and v[1] > 0]
    c = len(pairs)
    if not c:
        return {"delta": None, "lo": -1.0, "hi": 1.0, "p": 1.0, "cases": 0}
    d = sum(v1 / n1 - v0 / n0 for (v0, n0), (v1, n1) in pairs) / c
    rng = random.Random(seed)
    beta = rng.betavariate
    draws = []
    for _ in range(boot):
        s = 0.0
        for _ in range(c):
            (v0, n0), (v1, n1) = pairs[rng.randrange(c)]
            s += beta(v1 + .5, n1 - v1 + .5) - beta(v0 + .5, n0 - v0 + .5)
        draws.append(s / c)
    draws.sort()
    lo, hi = min(_pct(draws, 0.025), d), max(_pct(draws, 0.975), d)
    below = sum(1 for x in draws if x <= 0)
    above = boot - below
    p = min(1.0, 2 * (min(below, above) + 1) / (boot + 1))
    return {"delta": d, "lo": lo, "hi": hi, "p": p, "cases": c}


def holm(pvalues: Sequence[float], alpha: float = 0.05) -> tuple[list[float], list[bool]]:
    """Holm step-down correction. Returns (adjusted p-values, rejected?) in input order."""
    m = len(pvalues)
    order = sorted(range(m), key=lambda i: pvalues[i])
    adj = [1.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * pvalues[i]))
        adj[i] = running
    return adj, [a <= alpha for a in adj]


def min_detectable_effect(cases: int, trials: int, within_var: float, between_var: float = 0.0,
                          z_alpha: float = Z95, z_power: float = Z80_POWER) -> float | None:
    """Smallest paired difference (in points, 0-100) a same-cases A/B comparison
    could detect at 5% two-sided and 80% power.

    d = (z_a/2 + z_b) * sqrt((w^2 + s_A^2/K + s_B^2/K) / n)
    within_var = s^2 (per-trial Bernoulli variance inside a case, same for A and B),
    between_var = w^2 (variance of the true per-case difference; 0 gives the
    optimistic floor: nothing smaller than this is visible).
    """
    if cases <= 0 or trials <= 0:
        return None
    d = (z_alpha + z_power) * math.sqrt((between_var + 2 * within_var / trials) / cases)
    return round(100 * min(d, 1.0), 1)


def within_case_var(cells: Sequence[tuple[int, int]]) -> float:
    """Mean per-case Bernoulli variance p(1-p), with p shrunk to (c+.5)/(n+1) so
    all-pass or all-fail cases still count some noise."""
    cells = [(c, n) for c, n in cells if n > 0]
    if not cells:
        return 0.25
    ps = [(c + .5) / (n + 1) for c, n in cells]
    return sum(p * (1 - p) for p in ps) / len(ps)


def _pct(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return float("nan")
    i = q * (len(sorted_vals) - 1)
    lo = math.floor(i)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (i - lo)


# ---------- plain words ----------

TOO_WIDE = 0.6       # interval wider than this says nothing useful
BREAK_LO = 0.2       # lower bound of violation rate above this: it breaks
MIN_CASES = 2


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def pct(x: float) -> str:
    return f"{round(100 * x)}%"


def likely(lo: float, hi: float) -> str:
    return f"likely {round(100 * lo)}-{round(100 * hi)}%"


def rule_verdict(violated: int, checked: int, cases: int, lo: float, hi: float) -> str:
    """'too_few' | 'holds' | 'breaks' | 'flaky' for a rule's violation rate.

    too_few: fewer than 2 cases, or the 95% interval is wider than 60 points.
    holds:   zero violations (and not too_few).
    breaks:  interval lower bound above 20%, or violated in more than half the runs.
    flaky:   anything else (some violations, rate not clearly high).
    """
    if cases < MIN_CASES or hi - lo > TOO_WIDE:
        return "too_few"
    if violated == 0:
        return "holds"
    if lo > BREAK_LO or violated * 2 > checked:
        return "breaks"
    return "flaky"


def rule_sentence(violated: int, checked: int, cases: int, lo: float, hi: float, verdict: str) -> str:
    where = f"across {plural(cases, 'conversation')}" if cases > 1 else f"of {plural(cases, 'conversation')}"
    if violated == 0:
        head = (f"Held in all {plural(checked, 'run')} {where}" if checked > 1
                else f"Held in the 1 run {where}")
    else:
        head = f"Broke in {violated} of {plural(checked, 'run')} {where}"
    if verdict == "holds":
        return head
    if verdict == "too_few":
        return f"{head} ({likely(lo, hi)}); too little data to be sure"
    if verdict == "flaky":
        return f"{head} ({likely(lo, hi)}); flaky"
    return f"{head} ({likely(lo, hi)})"


def pts(x: float) -> str:
    v = round(100 * x)
    return f"{'+' if v > 0 else ''}{v}"


def ablation_sentence(section: str, rule: str, base: float, ablated: float, lo: float, hi: float,
                      significant: bool) -> str:
    """'Removing 'Refunds' raised R3 failures from 0% to 42% (likely +20 to +60 pts): ...'"""
    if round(100 * ablated) == round(100 * base):
        head = f"Removing '{section}' left {rule} failures at {pct(base)}"
    else:
        verb = "raised" if ablated > base else "cut"
        head = f"Removing '{section}' {verb} {rule} failures from {pct(base)} to {pct(ablated)}"
    ci = f"likely {pts(lo)} to {pts(hi)} pts"
    if lo > 0:
        tail = "this section holds the rule up" if significant else \
            "this section seems to hold the rule up, but it could be chance across all comparisons"
    elif hi < 0:
        tail = "this section causes the failures" if significant else \
            "this section seems to cause the failures, but it could be chance across all comparisons"
    else:
        tail = "can't tell yet whether this section matters"
    return f"{head} ({ci}): {tail}"
