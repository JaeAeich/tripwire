# Research notes: agent evals, attribution, prompt evolution, guards (2026-10-14)

Abstract-level verification only. [unverified] = snippet or secondary source.

## Evals for policy-bound tool agents
- τ-bench (Sierra, 2406.12045): simulated user + tools + policy, final DB-state grading, pass^k. gpt-4o <50% tasks, retail pass^8 <25%.
- τ²-bench (2506.07982): dual control (user also acts); big drop vs no-user mode. Simulator error ~47% airline convos [unverified].
- τ-Knowledge / τ³ (2603.04370): banking, ~25.5% pass^1. Results before v1.0.1 not comparable: version your scenarios.
- SABER (Amazon, 2512.07850): each deviation on a *mutating* step cuts success odds up to 92-96%; read-only deviations barely matter. Pre-mutation checks: +28%/+11% (Qwen3), +9%/+7% (Claude). τ-Bench Verified.
- τ²-bench-verified (github.com/amazon-agi/tau2-bench-verified): every expected outcome cites its policy clause.
- Log analysis (Princeton, 2605.08545): airline pass^5 underestimated by ~50%; ~25/50 tasks flawed [unverified]. Read failing transcripts.

## User simulators
- Sim2Real gap (CMU, 2603.11245): 451 real humans vs 31 simulators; simulators too cooperative ("easy mode"), inflate success.
- Lost in Simulation (Cohere, 2601.17087): up to 9 pt swing depending on simulator model.
- SimulatorArena (2510.05444): profile-conditioned simulators ρ≈0.7 with humans (non-agent tasks).
- Use: hard personas, 2+ simulator models, audit simulator turns, drop simulator-caused failures.

## LLM judges
- MT-Bench (2306.05685): >80% human agreement; position/verbosity/self bias.
- Judging the Judges (2406.12624): report kappa + confusion matrix, judges lenient.
- JudgeBench (2410.12784): GPT-4o near random on hard objective pairs: never judge what code can check.
- CALM (2410.02736): 12 biases, perturbation tests.
- EvalGen (2404.12272): criteria drift; draft rubric from real failures, then freeze.
- CompliBench (2604.12312): inject policy violations into dialogues to test judges.
- trajectory-judge (2609.00038): final-answer judge discrimination ~0 on process faults; per-step checking fixes it. Score paired faulty-vs-clean discrimination.

## Prompt optimization / evolution
- GEPA (2507.19457): reflective evolution + Pareto frontier; beats GRPO by 6-20% with up to 35x fewer rollouts, beats MIPROv2 >10%. No verified τ-bench result.
- ACE (2510.04618, ICLR 2026): incremental itemized edits; full rewrites cause "context collapse" (18k->122 tokens, 66.7->57.1, below baseline).
- TextReg (2605.21318): optimized prompts overfit and bloat; regularizer +11.8% OOD.
- p1 (2604.08801): optimization only works when inter-prompt variance > response noise; pick high-variance scenarios.
- POLCA (2603.14769) [snippet]: optimizes instructions on τ-bench retail, 10 train / 145 held out. Closest setup to ours.
- MIPROv2 (2406.11695), TextGrad (2406.07496), OPRO (2309.03409): baselines.

## Attribution
- ContextCite (2409.00729), AttriBoT (2411.15102): ablation-based attribution; hierarchical (section -> sentence), cheap proxy screening. Need logprobs.
- TokenSHAP / AgentSHAP: Monte Carlo Shapley, black-box.
- Causal Agent Replay (2606.08275): do(remove step), replay N times, Shapley with CIs. Synthetic validation only.
- IFScale (2507.11538): following degrades with rule count; earlier rules followed more.
- SCALEDIF (IBM, 2510.14842): conflicts between instructions drive degradation; conflict-scoring tool.
- Policy-Invisible Violations (2604.12177): many violations come from missing facts in context, not missing rules.

## Failure attribution
- Who&When (2505.00212): best 53.5% agent-level, 14.2% step-level. Aggregate over runs.
- MAST (2503.13657): 14 failure modes, o1 judge kappa 0.77 few-shot; workflow fixes beat prompt-only fixes.
- AgenTracer (2509.03312) [snippet]: counterfactual replay + fault injection to label failures.

## Runtime guards / "System 1" checks
- Reason Less, Verify More (2607.07405): 78% of failures were silent wrong-state writes; deterministic pre-write gates +12.4 pp (p=0.0012). No gain where tools already enforce policy.
- PolicyGuard (2606.29225): verifier sub-agent on mutating calls, PASS^4 +6 to +12 pp on τ2 airline.
- Sentinel / Policy-Invisible (2604.12177): simulate action on state graph, check invariants, 93.0% vs 68.8%.
- DynaGuard (2509.02563): small guard for free-text policies; claims near-frontier accuracy, fast.
- Solver-aided (2603.20449): policies -> SMT, Z3 checks calls on τ-bench (no numbers in abstract).
- AgentSpec (2503.18666), ShieldAgent (2503.22738), Progent (2504.11703): policy DSLs / rule circuits.
- Harm guards (Llama Guard 4, ShieldGemma, WildGuard): wrong tool for business rules; WildGuard useful for over-refusal.

## JEPA
V-JEPA 2 (2506.09985), LLM-JEPA (2509.14252), VL-JEPA (2512.10942): vision/robotics or a training objective. No text tool-agent results. Not usable here now.

## GEPA ecosystem (from the GEPA README "used by" list, 2026-10-14; claims as reported there)
- Nubank (support agents, 100M users): GEPA optimizes LLM-judge prompts; eval accuracy 68.9% -> 88.9%, kappa (4.1 vs 4.1-mini) 0.00 -> 0.745.
- WER is Unaware (IWSDS 2026): GEPA-optimized judge, 90% acc, kappa 0.816.
- Redwood/Pivotal "Attack Selection": GEPA-optimized red-team prompts beat handwritten ones at evading monitors.
- GEPA-optimized personas for realistic market-research focus groups.
- Databricks: enterprise agents 90x cheaper (small model + GEPA to match big model).
- Reinforced Agent: reviewer + GEPA for tool-calling agents. RLM-GEPA on AppWorld: SGC 0.839 -> 0.911.
- Google ADK `adk optimize`, OpenAI cookbook (self-evolving agents), Opik, HF cookbook all ship GEPA.
- DD-GEPA: three named prompt components optimized separately.

## GEPA library hooks (src/gepa/api.py, adapter.py)
- `GEPAAdapter.evaluate(batch, candidate, capture_traces)` -> `EvaluationBatch(outputs, scores, trajectories, objective_scores)`; `make_reflective_dataset(candidate, eval_batch, components_to_update)`.
- Candidate = dict of named text components -> one per prompt section.
- `module_selector`: "round_robin" | "all" | custom `ReflectionComponentSelector` -> plug attribution in here.
- `objective_scores`: per-example dict -> one objective per policy rule (Pareto across rules).
- `candidate_selection_strategy` ("pareto"), `reflection_minibatch_size` (3), `max_metric_calls`, `use_merge`, `reflection_lm`.

## Attack / red-team for policy agents (2026-10-16, subagent sweep, abstract-level)
- CRAFT / τ-break (IBM, 2506.09600, EMNLP'25): policy-aware red-teamer pulls relevant policy clauses, plans persuasion; airline ASR 70% vs emotional 50%, DAN 35%. Template for our attacker; τ-break = external benchmark.
- IntellAgent (2501.11067): policy graph, sample policy combos + DB state, graded difficulty; correlates with τ-bench. Archive axis = which rules an attack hits.
- SIRAJ (Microsoft, 2510.26037): diverse seeds (risk outcome × tool trajectory × risk source), 2-2.5x coverage; distilled 8B red-teamer [snippet].
- Diversity-Guided User Simulation (2604.21480): "benevolence bias" of simulators [method unverified].
- CompliBench (2604.12312): perturb guidelines to plant known violations; frontier judges over-flag and miss. Judge calibration.
- GOAT (Meta, 2410.01606): attacker per-turn Observation/Thought/Strategy/Response over 7 techniques; ASR@10 97% Llama 3.1. Core attacker turn loop. Crescendo (2404.01833): gradual escalation. PAIR (2310.08419), TAP (2312.02119): cheap single-message refinement. X-Teaming (2504.13203): planner + optimizer + verifier. ActorAttack (2410.10700): pretext diversity. AutoDAN-Turbo (2410.05295): persistent strategy library.
- Quality-diversity: Rainbow Teaming (2402.16822, MAP-Elites grid), Ruby Teaming (2406.11654, memory; Shannon/Simpson evenness), RainbowPlus (2504.15047, many elites per cell, 9x faster than AutoDAN-Turbo).
- Co-evolution: Self-RedTeam (2506.07468, online self-play RL), MAGIC (2602.01539, separate attacker/defender optimization). Both weight-level; borrow alternation at prompt level.
- Attack Selection (2602.04930 App. H.1): GEPA in an AI-control red-team; anti-overfit: strip attack-specific details, weight false positives. LessWrong note: optimizing the monitor/defender paid off more than optimizing the attacker.
- No 2026 adversarial τ²-bench variant found; no published GEPA-optimized attacker for policy agents found.
- Injection benchmarks (AgentDojo 2406.13352, InjecAgent 2403.02691, PISmith 2603.13026): different threat model; only if tools return untrusted text.

Design sketch (attack stage): planner (policy + target clause -> goal, persona, pretext, escalation) + GOAT-style executor (8-12 turns), strategy library; MAP-Elites archive over clause × tactic × persona, k elites/cell, scored by code-check violation > judge severity > fewer turns; realism filter (DB-consistent persona, no DAN text, LLM plausibility check calibrated on ~50 hand labels); successful elites -> frozen cases, promote if they reproduce >=2/3-5; train vs held-out attack pools + benign look-alikes (legit $70 refund) so the defender can't just refuse; alternate attacker round / GEPA defender round; cost: screen with opening message, stop the conversation when a check fires, cheap executor + strong planner, budget per cell.

## Prior art and positioning (2026-10-16, subagent sweep)
Gap is real but narrow: each piece exists; no tool chains black-box section attribution (ablation + CIs) -> targeted per-rule evolution -> evolving adversarial customers.
- Eval + attack, no optimizer: promptfoo (tau-bench-style simulated user + red-team; acquired by OpenAI Mar 2026), Giskard Hub 3.0, Collinear (TraitMix personas), Guardrails Snowglobe, Haize Labs (reportedly acquired Sep 2026 [unverified]).
- Evolution: DSPy/GEPA; GEPA optimize_anything (2605.19633) already has per-objective Pareto fronts -> "each rule = objective" is NOT novel. Google ADK `adk optimize` (GEPA), SAMMO (section-level mutations, multi-objective), AutoPDL, PromptWizard, TextGrad. OpenAI prompt optimizer deprecated; OpenAI Evals shuts down 2026-11-30.
- Evolution UI: gepa-viz (modaic-ai): candidate tree, diff vs parent, per-example pass/fail, Pareto front. Closest to our UI idea -> don't claim the diff UI as novel.
- "What to fix" diagnosis (LLM-guessed, not causal): Opik HRPO (root-cause then surgical edits), Patronus Percival, Arize Phoenix Prompt Learning (+ red-team->optimizer loop with MS Foundry, human-reviewed), Braintrust Loop.
- DAAF (Tencent, 2609.32498): closest attribution prior: predicts which editable asset to change, trained on replays on tau2-bench; hands off to "an optimizer or human". tripwire = that handoff, untrained, by ablation.
- Co-evolution: AEGIS (2509.00088, injection detection), AgentSafeEvo (2610.19422, agent tasks not personas), CART (2609.27336, closed-loop red-team only).
Positioning: (1) lead with causal, statistically grounded attribution vs LLM-guessed diagnosis; benchmark section choice vs DAAF and vs GEPA round-robin (rollouts to reach target pass^k). (2) Claim the regression guard: per iteration, show load-bearing sections a mutation broke (attribution-aware diffs; gepa-viz lacks it). (3) Attack = co-evolution for business-policy agents (CRAFT-style customers vs evolving prompt), headline metric pass^k under the adversarial distribution.

## Native tool calls under claude -p (2026-10-16, subagent, docs + `claude --help` v2.1.296)
- Cause: --json-schema adds a StructuredOutput tool, so the model is in tool mode; our _render lists tools as `name(args)` and history as `[you called] name {...}`, so it tries to call them. No flag forbids attempts at undefined tools (`--tools ""` only removes built-ins).
- Fix ranked: (1) real tools via a stdio MCP bridge (tripwire.mcp_bridge) forwarding tools/call over a unix socket to the harness env; one claude -p call per agent turn; drop --json-schema (final text = reply). Flags: ENABLE_TOOL_SEARCH=false, MCP_TIMEOUT, --strict-mcp-config --mcp-config {tw stdio, alwaysLoad}, --allowedTools "mcp__tw__*", --permission-mode dontAsk --permission-prompts none, --max-turns MAX_TOOL_ROUNDS+1. Names appear as mcp__tw__<tool>; built-in EndConversation can't be removed when MCP tools exist (record it). Protocol v3, not comparable to v2. (2) Python claude-agent-sdk with in-process MCP server + ClaudeSDKClient session per trial (native history, caching; new dep). (3) prompt-only: "actions" JSON catalogue, history as JSON, few-shot; reduces, likely doesn't end it. (4) json-schema tweaks: nothing works.
