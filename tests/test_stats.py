"""Small-sample stats: known values, estimators, corrections, and summaries built on them."""

import math

import pytest

from tripwire.attribute import summarize as attr_summarize
from tripwire.core import stats
from tripwire.core.trace import Run, Trial, Verdict
from tripwire.eval import summarize


@pytest.mark.parametrize("x,n,lo,hi", [
    # Newcombe (1998), Stat Med 17:857, Table I, method 3 (Wilson score)
    (81, 263, 0.2553, 0.3662),
    (15, 148, 0.0624, 0.1605),
    (0, 20, 0.0, 0.1611),
    (1, 29, 0.0061, 0.1718),
])
def test_wilson_textbook(x, n, lo, hi):
    a, b = stats.wilson(x, n)
    assert a == pytest.approx(lo, abs=1e-4) and b == pytest.approx(hi, abs=1e-4)


def test_wilson_never_collapses():
    lo, hi = stats.wilson(3, 3)
    assert hi == 1.0 and 0.4 < lo < 0.5
    assert stats.wilson(0, 0) == (0.0, 1.0)


def test_clustered_rate():
    # independent-looking cases: n_eff = trials, same as plain Wilson
    r = stats.clustered_rate([(0, 3), (0, 3), (0, 3)])
    assert r["rate"] == 0 and r["cases"] == 3 and (r["lo"], r["hi"]) == pytest.approx(stats.wilson(0, 9))
    # all-or-nothing cases: trials are copies, n_eff falls to the number of cases
    r = stats.clustered_rate([(3, 3), (0, 3), (0, 3)])
    assert r["rate"] == pytest.approx(1 / 3) and r["n_eff"] == 3
    assert (r["lo"], r["hi"]) == pytest.approx(stats.wilson(1, 3))
    # mixed within cases: between the two
    r = stats.clustered_rate([(1, 3), (2, 3), (1, 3)])
    assert 3 <= r["n_eff"] <= 9


def test_pass_hat_k_unbiased():
    assert stats.pass_hat_k_case(3, 3, 3) == 1 and stats.pass_hat_k_case(2, 3, 3) == 0
    assert stats.pass_hat_k_case(4, 5, 3) == pytest.approx(math.comb(4, 3) / math.comb(5, 3))  # 0.4
    assert stats.pass_hat_k_case(1, 5, 1) == pytest.approx(0.2)
    assert stats.pass_at_k_case(1, 5, 2) == pytest.approx(1 - math.comb(4, 2) / math.comb(5, 2))  # 0.4
    with pytest.raises(ValueError):
        stats.pass_hat_k_case(1, 2, 3)
    r = stats.pass_hat_k([(5, 5), (4, 5), (1, 2)], 3)  # third case skipped (n < k)
    assert r["cases"] == 2 and r["mean"] == pytest.approx(0.7)
    assert r["lo"] <= 0.7 <= r["hi"]


def test_mean_ci_open_when_all_agree():
    r = stats.mean_ci_over_cases([1, 1, 1])
    assert r["hi"] == 1 and r["lo"] < 0.5  # a bootstrap alone would say [1, 1]


def test_holm():
    adj, rej = stats.holm([0.01, 0.04, 0.03, 0.005])
    # sorted: .005*4=.02, .01*3=.03, .03*2=.06, .04*1=.04 -> monotone .06
    assert adj == pytest.approx([0.03, 0.06, 0.06, 0.02])
    assert rej == [True, False, False, True]
    assert stats.holm([]) == ([], [])


def test_paired_diff():
    same = stats.paired_diff([((0, 4), (0, 4))] * 3)
    assert same["delta"] == 0 and same["lo"] < 0 < same["hi"] and same["p"] > 0.5
    big = stats.paired_diff([((0, 5), (5, 5))] * 4)
    assert big["delta"] == 1 and big["lo"] > 0.3 and big["hi"] == 1 and big["p"] < 0.01
    # deterministic
    assert stats.paired_diff([((1, 4), (3, 4))]) == stats.paired_diff([((1, 4), (3, 4))])
    assert stats.paired_diff([])["delta"] is None


def test_min_detectable_effect():
    # (1.96 + 0.84) * sqrt(2 * 0.25 / 4 / 25) = 0.198
    assert stats.min_detectable_effect(25, 4, 0.25) == pytest.approx(19.8, abs=0.1)
    assert stats.min_detectable_effect(0, 3, 0.25) is None
    assert stats.min_detectable_effect(1000, 3, 0.25, 0.0) < 4


def test_verdicts_and_sentences():
    lo, hi = stats.wilson(0, 9)
    assert stats.rule_verdict(0, 9, 3, lo, hi) == "holds"
    assert stats.rule_sentence(0, 9, 3, lo, hi, "holds") == "Held in all 9 runs across 3 conversations"
    lo, hi = stats.wilson(2, 3)
    assert stats.rule_verdict(2, 3, 1, lo, hi) == "too_few"
    assert stats.rule_sentence(2, 3, 1, lo, hi, "too_few") == \
        "Broke in 2 of 3 runs of 1 conversation (likely 21-94%); too little data to be sure"
    lo, hi = stats.wilson(1, 12)
    assert stats.rule_verdict(1, 12, 4, lo, hi) == "flaky"
    assert stats.rule_sentence(1, 12, 4, lo, hi, "flaky").endswith("; flaky")
    lo, hi = stats.wilson(10, 12)
    assert stats.rule_verdict(10, 12, 4, lo, hi) == "breaks"
    s = stats.ablation_sentence("Refunds", "R3", 0.0, 0.42, 0.2, 0.6, True)
    assert s == "Removing 'Refunds' raised R3 failures from 0% to 42% (likely +20 to +60 pts): " \
                "this section holds the rule up"


def _trial(cid, i, ok, rule="R1", variant="base"):
    return Trial(cid, i, variant, verdicts=[Verdict(rule, "c", ok, "state")], passed=ok)


def test_eval_summary_synthetic():
    run = Run.new("eval", "s", {"k": 3})
    outcomes = {"a": [1, 1, 1], "b": [1, 1, 1], "c": [1, 0, 1], "d": [0, 0, 0]}
    for cid, ps in outcomes.items():
        for i, p in enumerate(ps):
            run.trials.append(_trial(cid, i, bool(p)))
    s = summarize(run)
    assert s["pass_at_1"] == pytest.approx(8 / 12) and s["pass_hat_k"] == pytest.approx(0.5)
    lo, hi = s["pass_at_1_ci"]
    assert lo < 8 / 12 < hi
    assert s["pass_hat_k_ci"][0] < 0.5 < s["pass_hat_k_ci"][1]
    assert s["min_detectable_effect"] > 10
    r = s["per_rule"]["R1"]
    assert (r["checked"], r["violated"], r["cases"]) == (12, 4, 4)
    # failures sit in whole cases, so n_eff ~ 4 cases and the interval is too wide to call
    assert r["lo"] < r["rate"] < r["hi"] and r["hi"] - r["lo"] > 0.6 and r["verdict"] == "too_few"
    assert r["sentence"].startswith("Broke in 4 of 12 runs across 4 conversations (likely ")
    assert r["sentence"].endswith("too little data to be sure")
    # same failure count spread across many cases: enough data, flaky
    run = Run.new("eval", "s", {"k": 3})
    for c in range(8):
        for i in range(3):
            run.trials.append(_trial(str(c), i, not (i == 0 and c < 2)))
    r = summarize(run)["per_rule"]["R1"]
    assert r["verdict"] == "flaky" and r["sentence"] == f"Broke in 2 of 24 runs across 8 conversations " \
        f"(likely {round(100 * r['lo'])}-{round(100 * r['hi'])}%); flaky"


def test_eval_pass_hat_k_unbiased_when_n_gt_k():
    run = Run.new("eval", "s", {"k": 2})
    for i, p in enumerate([True, True, False]):  # n=3, c=2, k=2 -> 1/3 (old code: all(first 2) = 1)
        run.trials.append(_trial("a", i, p))
    assert summarize(run)["pass_hat_k"] == pytest.approx(1 / 3)


def test_attribution_summary_paired():
    run = Run.new("attribute", "s", {"k": 4})
    for cid in "abc":
        for i in range(4):
            run.trials.append(_trial(cid, i, True, "R1"))
            run.trials.append(_trial(cid, i, False, "R1", "ablate:Refunds"))
            run.trials.append(_trial(cid, i, True, "R1", "ablate:Tone"))
    s = attr_summarize(run)
    m = {x["section"]: x for x in s["matrix"]}
    assert m["Refunds"]["delta"] == 1 and m["Refunds"]["lo"] > 0 and m["Refunds"]["significant"]
    assert m["Refunds"]["role"] == "load-bearing" and m["Refunds"]["ci"] == [m["Refunds"]["lo"], m["Refunds"]["hi"]]
    assert m["Refunds"]["sentence"].endswith("this section holds the rule up")
    assert m["Tone"]["role"] == "unclear" and not m["Tone"]["significant"]
    assert s["headline"]["top"] == m["Refunds"]["sentence"]


def test_crashed_trials_and_broken_checks_not_counted():
    ok = lambda c, i: Trial(c, i, verdicts=[Verdict("R1", "x", True, "state")], passed=True)  # noqa: E731
    crashed = Trial("a", 2, verdicts=[Verdict("R1", "x", False, "judge", "check error: rate limit", error=True)],
                    error="BackendError: rate limit")
    broken = Trial("b", 2, verdicts=[Verdict("R1", "x", True, "state"),
                                     Verdict("R2", "j", False, "judge", "check error: bad", error=True)], passed=True)
    run = Run("r", "eval", "s", 0, config={"k": 3}, trials=[ok("a", 0), ok("a", 1), crashed, ok("b", 0),
                                                            ok("b", 1), broken])
    s = summarize(run)
    assert s["pass_at_1"] == 1.0 and s["trials"] == 5
    assert s["errors"] == 1 and s["check_errors"] == 1
    assert "R2" not in s["per_rule"] and s["per_rule"]["R1"]["violated"] == 0


def test_run_from_dict_marks_legacy_check_errors():
    from tripwire.core.trace import run_from_dict
    d = Run("r", "eval", "s", 0, trials=[Trial("a", 0, verdicts=[
        Verdict("R1", "x", False, "state", "check error: boom")])]).to_dict()
    for v in d["trials"][0]["verdicts"]:
        del v["error"]
    assert run_from_dict(d).trials[0].verdicts[0].error
