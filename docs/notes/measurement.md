# Measurement methods (subagent sweep 2026-10-16)

Key point: few cases per intent and few trials, so small-sample intervals and paired designs matter more than in big benchmarks.

## Per-intent scores
- Unit = case. Cluster standard errors by case; trials only reduce within-case noise. Miller, Adding error bars to evals, 2411.00640.
- Small n: use Wilson intervals or a Beta posterior over cases. Normal-approximation intervals are too narrow and collapse at 0%/100% (Bowyer 2503.01747).
- pass^k: per case use the unbiased C(c,k)/C(n,k), then average; never mean^k. Run n > k. pass@k = 1 - C(n-c,k)/C(n,k). Get its CI by bootstrapping over cases.
- Don't lower temperature to cut variance (adds bias).

## Comparing prompt versions
- Pair everything: same cases and same simulator seeds; report the per-case difference with its SE.
- Power: n = (z_a/2 + z_b)^2 * (w^2 + s_A^2/K_A + s_B^2/K_B) / d^2. A 3-point gap needs ~1,000 cases, so show users the minimum detectable effect.
- Evolution: train / selection / held-out splits; report only on held-out. Track prompt length (TextReg 2605.21318).
- Holm or BH correction across variants × intents. Reusable holdout (Dwork 2015) [unverified].

## Attribution significance
- Paired ablation per section; CI by bootstrapping over cases; Holm/BH across sections.
- Leave-one-out misses redundancy: two sections stating the same rule each look useless alone (2507.04480). Signal: full prompt much better than any single ablation explains.
- Staged: group testing on section groups, drill into ones that matter, then Monte Carlo permutation Shapley (TokenSHAP 2407.10114, llmSHAP 2511.01311) only on survivors.

## Adaptive trial budgets
- Prompt selection: fixed-budget best-arm identification with sequential halving (TRIPLE 2402.09723).
- Beta posterior per intent × variant cell; send trials to cells whose interval still crosses the decision boundary; stop resolved cells.
- Repeated CI peeking breaks coverage: use anytime-valid confidence sequences / e-processes (CELEUS 2606.20820, SERPANT ICML 2026 [id unverified]).
- After ~3-5 trials per case, more cases beat more trials.

## Judge calibration
- Code checks first; judge only semantic rules. Frontier judges struggle to detect guideline violations; a small fine-tuned judge does better (CompliBench 2604.12312).
- Label 100-200 stratified (case, rule) pairs. Report per-rule TPR/FPR, Cohen's kappa, confusion matrix.
- Correct rates with Rogan-Gladen or PPI++ (2601.05420; PPI 2301.09633 [unverified]): up to 10x narrower intervals with valid coverage.
- A judge with low agreement on a rule doesn't decide that rule.

## Simulator validity
- Sim2Real 2603.11245 (31 simulators, 451 humans): simulators too cooperative and uniform, inflate success; a stronger model doesn't make a more faithful simulator.
- Keep a small human panel and report the sim-vs-human gap per intent (User-Sim Index; formula unconfirmed). Label scores "simulated"; vary personas.

## Cost metering
- Log OTel GenAI usage fields: input, output, cache_read, cache_creation tokens (still Development).
- Price each token class separately; reasoning tokens sit inside output.
- Show cost per trial, cost per passing trial, latency p50/p95 per variant.

## UI
- Score: "17/20 passed · 85% (likely 64-95%)", a bar with an interval; always show counts.
- Comparison verdict in words: "B better by 8 pts (±5)" / "worse" / "can't tell yet, ~N more cases". Color only if the corrected interval excludes 0.
- Badges: "insufficient data", "simulated", "judge kappa=0.6".
- pass^k beside pass@1: "fails at least once in 5 runs: 40%".
