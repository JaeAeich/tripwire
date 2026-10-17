# tripwire as a product (draft 2026-10-16)

Synthesis of docs/notes/{practitioners,integration,measurement,market}.md and RESEARCH.md. Decisions marked **[decide]** are open.

## One line

**git bisect for system prompts.** Find which part of your prompt holds each rule up and which part breaks it, attack it, and fix it, with numbers you can trust.

## Who it's for

The engineer (and the domain expert next to them) who owns a policy-bound agent: support, fintech, healthcare intake, sales. They already have tracing. Half of them have no offline evals. Their prompt keeps growing, they're scared to delete lines, and every model upgrade breaks something.

## Their pains we target (from practitioners.md)

| Pain | What tripwire gives |
|---|---|
| Prompt rot: it grows, nobody dares delete lines | The map shows dead weight and load-bearing sections, so you can prune safely |
| Model upgrade breaks prompts | "Change model, re-run the map": see which rules moved and which section to fix |
| Simulated users are too nice | Attacks aimed at specific rules |
| Auto-optimizers overfit and produce unreadable prompts | Evolution edits one section at a time, shows a readable diff, needs human accept, held-out check, length budget |
| Judges aren't trusted | Code checks first; judge only for soft rules, calibrated on a few dozen human labels, agreement shown |
| Can't write all rules upfront (criteria drift) | Intents drafted from the prompt, edited in plain words, refined as failures appear |

Not targeted (others do it well): tracing, dashboards, prompt registries.

## The loop

1. **Bring:** a prompt (paste, file, or registry pull), tools (schemas; optional sample data), optionally real transcripts.
2. **Intents:** drafted from the prompt, edited by a human. Each gets a check: code when possible, judge otherwise.
3. **Cases:** seeded from real transcripts if given, else generated; attacks add more.
4. **Map:** paired ablation per section × intent, with CIs. Group sections first, drill into ones that matter.
5. **Attack:** a planner picks a target intent and writes a persona + plan; an attacker plays the customer. Attacks that reliably work become cases. Harmless look-alikes are added so "refuse everything" doesn't win.
6. **Evolve:** rewrite the section the map blames, one at a time. Train/selection/held-out splits. Keep only edits that improve the target intent without breaking intents other sections hold (the regression guard).
7. **Loop:** if evolution can't fix it, the map says why, and a human decides.

## Measurement rules (from measurement.md)

- Unit is the case, not the trial. Wilson / Beta intervals. pass^k per case with the unbiased estimator.
- Always pair: same cases and seeds for every variant.
- Spend runs where results are still uncertain; stop resolved cells. Use anytime-valid stopping if we peek.
- After 3–5 trials per case, add cases, not trials.
- Show uncertainty in words: "85% (likely 64–95%)", "B better by 8 pts (±5)", "can't tell yet: ~N more cases". Badges: simulated, judge agreement, too little data.
- Every result shows cost.

## Architecture

**v1**
- Runner: own agent loop. Tools are real (native tool calls; via MCP for `claude -p`). Models through the user's own keys (LiteLLM) or `claude -p`.
- Fake tools:
  - stateful LLM simulator by default (schemas + sample data, logged for exact replay)
  - deterministic Python mocks when exactness matters (Paylane-style)
- Cache every model call by hash for replay and cheap reruns. Use prompt caching (ablations share long prefixes).
- CLI that writes JSON results; GitHub Action that fails below a threshold.
- UI: local web app over the run files, also exportable as a static site (demo + blog).

**v1.5**
- "Bring your agent": an adapter `(system_prompt, messages, tool_endpoint)`; tripwire hands the agent an MCP server it controls.
- Adapters: Claude Agent SDK, OpenAI Agents SDK, Pydantic AI.
- Import transcripts / OTel traces as cases.
- Export suites to promptfoo / Langfuse.

## Positioning and market (from market.md)

- Commoditized: tracing, judges, datasets, prompt versioning, CI evals, red-team probe lists, basic user simulators. Big players own these (OpenAI bought promptfoo, ClickHouse bought Langfuse, Cisco bought Galileo).
- Open: section-level attribution (no tool exists), rule-targeted attacks, statistically honest results, a closed loop.
- Closest prior art: Tencent DAAF (learned "which asset to change", no rewriting), gepa-viz (evolution UI), CRAFT (policy attacks), Opik HRPO / Patronus Percival (LLM-guessed diagnosis).
- Claim: measured attribution (not guessed), regression guard during evolution, pass^k under attack.
- Don't claim: per-rule Pareto, evolution diff UI (both exist).

## Go-to-market

1. Flagship post on a public benchmark agent (τ²-bench retail or airline), not Paylane. Heatmap + one surprising finding + real cost.
2. Show HN: `pipx install tripwire`, 60 s GIF, static demo site.
3. Integrations that get found: promptfoo provider, Langfuse export, GEPA hook.
4. For the job hunt, lead with the infra story: replay cache, budget-aware scheduler, statistical stopping, cost per insight.

## Tensions to decide

- **[decide] UI scope.** The market note says "CLI on top of their stack, no UI". The user wants a polished UI that walks through everything. Proposed: a local UI plus a static export. It's the demo and the blog's interactive figure, not a hosted SaaS.
- **[decide] Evolve timing.** The market note says ship evolution later, gated on attribution. The user's loop includes it. Proposed: build it, but as "suggest an edit + prove it", not autopilot.
- **[decide] Demo scenario.** Paylane is Fini's brief. Proposed: move to τ²-bench retail/airline for anything public; keep Paylane private as a dev fixture.
- **[decide] Fake tools.** LLM-simulated by default, Python mocks optional (proposed: both).

## Build order (proposed)

1. Real tool calls (MCP bridge for `claude -p`), protocol v3, call cache. Rerun baseline. *Foundation.*
2. Stats layer: case-clustered CIs, paired comparisons, plain-words verdicts. Retrofit attribution to it.
3. Generic scenario format: prompt + tool schemas + LLM tool simulator + intents. Port τ²-bench retail as scenario #2.
4. Attack (planner + attacker + archive → cases).
5. Evolve (section rewrite + regression guard + held-out).
6. UI: one guided flow over the loop + static export.
7. Blog post + launch.
