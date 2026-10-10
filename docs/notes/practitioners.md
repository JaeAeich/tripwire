# How teams build and test agent prompts today (subagent sweep 2026-10-16)

Vendor sources are self-reported. No survey found on prompt versioning or who owns prompts.

## Workflow
1. Engineer writes the system prompt and spot-checks it in a playground (a "vibe check"). Applied LLMs: vibe checks are signals of bad outputs; code and assertions operationalize them. https://applied-llms.org/
2. Ship with tracing. 89% have observability; only 52% run offline evals and 37% online evals (LangChain State of Agent Engineering, Nov–Dec 2025, n=1,340). https://www.langchain.com/state-of-agent-engineering
3. Error analysis on production traces: free-text note per failure (open coding), then group into a taxonomy (axial coding). Hamel Husain's team spends 60–80% of dev time on error analysis and evaluation. https://hamel.dev/blog/posts/evals-faq/
4. Patch the prompt per failure. One practitioner adds a rule after 3+ logged failures share a pattern.
5. Failures go into a small CI regression set; deterministic assertions preferred over judges.
6. Support vendors gate releases with simulated users:
   - Sierra: simulations from SOPs and transcripts, wired into CI/CD.
   - Decagon: personas from past failed transcripts; uses GEPA in production but says results depend heavily on configuration.
   - Intercom Fin: simulations per Procedure, plus batch tests of up to 50 questions graded by hand.

## Pains, ranked
1. Quality/reliability is the #1 blocker (about a third of respondents).
2. Evals lag observability (52% offline, 37% online vs 89% tracing).
3. Model swaps break prompts. a16z: "all the prompts have been tuned for OpenAI." Voiceflow saw a -10% intent drop between GPT-3.5 versions.
4. Criteria drift (EvalGen 2404.12272): you can't write the rules fully upfront.
5. Prompts cover the happy path and rot; patching makes them grow (hard data thin).
6. Domain experts are locked out because prompts live in code.
7. Generic metrics give false confidence.
8. Multi-turn and voice testing is hard (why simulation products exist).

## What practitioners distrust
- **LLM judges:** ~53% use them, but experts insist on checking them against human labels; one judge per failure type.
- **Auto-optimizers:**
  - Overfit: a Datasette case went train 90→95%, held-out 95→85% [unverified, n=30].
  - Unreadable: one team got a prompt 4x longer, partly irrelevant to a reader.
  - Can't discover new failures (Hamel).
  - A tech radar advises human review.
- **Fully synthetic users:** replaying real conversation prefixes often works better; prove you can trigger an error before building an eval for it.

## Implications for tripwire
- **Addresses:**
  - Prompt rot: attribution shows what's load-bearing, so bloat can be pruned safely.
  - Model swaps: re-run the map and attacks on the new model.
  - Multi-turn testing: adversarial users.
  - Criteria drift, partly: drafted intents give people something to react to.
- **Doesn't address:**
  - Real-trace error analysis: synthetic-only misses real failures.
  - Judge trust.
  - Evolve will draw the same overfitting and readability criticism as GEPA.
  - Ownership.
- **Onboarding needs:**
  - Accept prompt plus sample real transcripts; seed attacks from their failures.
  - Intents editable in plain language by a domain expert, who labels a few dozen outputs to calibrate the judge with visible agreement.
  - Evolved prompts as readable diffs a human accepts, with held-out tests and a length budget.
  - Export the regression suite to CI.
  - "Change model, re-run" as a headline use case.
