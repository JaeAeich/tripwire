# What we built, what broke, what we learned

Plain-words log for the blog post. Newest at the bottom of each section. Numbers are from real runs in `runs/`.

## The question

You write a system prompt with rules ("never refund over $75", "verify before showing account details"). The agent breaks a rule. **Which line of the prompt is responsible?** And can a machine fix the prompt for you, and then attack it to find what still breaks?

tripwire is three tools on one harness:
1. **Eval**: run scripted customer conversations against the agent, check each rule, score it.
2. **Attribution**: remove one prompt section at a time, rerun, see which rule scores change. That tells you which section holds each rule up and which section causes failures.
3. **Evolution** (next): let a model rewrite the prompt, keep only edits that improve scores. **Attack** (later): let a model write nastier customers to break the evolved prompt.

## The product loop (decided 2026-10-16)

tripwire is a platform where you bring a prompt and find out what it really does.

1. **Prompt + intent.** You paste a prompt. tripwire drafts the intents (the rules it should hold) from it; you edit them.
2. **Map (attribution).** Which section of the prompt carries each intent, and which section works against one.
3. **Attack.** Press a button: tripwire writes hostile customers aimed at each intent and shows what breaks.
4. **Evolve.** Rewrite the prompt to fix what broke, one section at a time, keeping only edits that help and don't break other intents.
5. **Loop.** If evolution can't fix it, go back to the map: it shows which section is causing the error, so a human can decide.

Each stage feeds the next: successful attacks become new test cases, which make the map sharper.

## How an eval works

- A **scenario** = rules + prompt split into named sections + fake tools (look up customer, issue refund, escalate) + fake data.
- A **case** = a customer script ("I want a refund for $90, I'm a loyal customer…") plus checks ("issue_refund was never called").
- A **simulated user** (another model) plays the customer from the script; the **agent** answers and calls tools.
- **Checks** grade the transcript. Code checks wherever possible (was a tool called, with what amount); a **judge** model only for things code can't see (tone).
- Each case runs **k** times because models are random. We report **pass@1** (average pass rate) and **pass^k** (passed all k times: the "can you rely on it" number).

## How attribution works

- Take the prompt, delete one section (e.g. "Refunds"), rerun all cases k times. Compare each rule's failure rate with and without that section.
- If removing a section makes a rule fail more: that section is **load-bearing** for the rule.
- If removing it makes a rule fail less: that section is a **culprit** (it was causing failures).
- If the confidence interval crosses zero: **unclear**. Most results are unclear until you have enough cases per rule.
- This is the black-box version of ContextCite / Causal Agent Replay (see RESEARCH.md). No access to model internals needed.

## Research we leaned on (details + links: RESEARCH.md)

- **τ-bench and successors**: the standard setup (simulated user + tools + policy). Key lessons: report pass^k, version your scenarios because old results stop being comparable, and many benchmark failures are actually broken tasks.
- **Simulators are too nice**: simulated customers cooperate more than real ones, which inflates scores. So scripts need pushy personas.
- **Judges are biased and lenient**: never use a judge for something code can check.
- **Mutating actions matter most** (SABER, "Reason Less, Verify More"): wrong refunds hurt far more than wrong lookups. Checks focus on refund/escalate calls.
- **Prompt evolution**: GEPA (reflective rewrites + keeps a Pareto front across goals) is the best-supported method. ACE warns that full rewrites collapse the prompt, so edit incrementally. TextReg warns that evolved prompts overfit and bloat.
- **Our angle**: nobody we found connects attribution to evolution. Plan: attribution picks *which section* GEPA should rewrite, and each rule is its own objective.

## What broke along the way (the honest part)

1. **First baseline, 6 cases × 3 (2026-10-14)**: pass@1 0.50. Reading the failing transcripts showed 2 of 6 failures were our harness (the agent was told tools "don't exist" by confusing wording) and 2 were over-strict checks. Only 2 were real. *Lesson: read transcripts before trusting a number.*
2. **First attribution**: "Refunds" section holds up the refund rule (42% → 100% failure when removed). A line we planted to cause trouble ("avoid refusing bluntly") was **not** detected as a culprit. Everything else unclear: 1–2 cases per rule is too few.
3. **39-minute hang**: a `claude -p` call never returned. Cause: its child processes held the output pipe open, so the timeout never fired. Fix: run each call in its own process group, kill the whole group, plus a per-conversation time budget (10 min), retries, and a Stop button.
4. **Leaked tools (MCP leak)**: the agent could see the user's own claude.ai connectors (calendar, docs…) as tools. Fix: `--strict-mcp-config`. Side effect: cost per conversation fell ~8× (~$0.016 → ~$0.002) because those tool descriptions were being sent every call.
5. **Native tool attempts**: the model kept trying to call tools directly instead of writing them in its JSON answer, got "no such tool", then told the customer "I wasn't able to…". I first called one of these a real agent failure. It wasn't. Fix: detect it and redo the step (up to 5×), count the redos. With both fixes, case 01 went 0/3 → 3/3.
6. **Consequence**: every run before 2026-10-15 15:13 is not comparable. Baseline rerun under the fixed harness: see below.

## Results under the fixed harness

- Baseline rerun 2026-10-16 (`20261016-144524-eval-7a91`, 6 cases × 3, $0.164): pass@1 0.78, pass^3 0.67. Refund, verification and leak rules held in every trial.
- But 3 of the 4 failures were the harness again: the model kept trying to call tools directly, and we gave up after 5 redos. Redos happened in almost every conversation (0–13 each), and they're why it cost $0.16, not the $0.04 we estimated. Only 1 failure (legal threat, case 05) might be a real agent failure.
- *Lesson: the JSON-in-text tool protocol fights the model. It wants real tools.* Next fix: give it real tools (see research).
- Real tools (protocol v3: tools passed to `claude -p` through a small MCP bridge). Baseline again (`20261016-153641-eval-4ee5`, 6 cases × 5, $0.27): pass@1 0.97, pass^5 0.83, zero redos. Only one rule failed once (R5, 1 of 5). Most of the cost is now the Sonnet judge, not the agent.
- First prompt tripwire had never seen: a 30-line returns-store prompt, drafted into a scenario automatically ($0.21, 51 s: 9 promises, 24 conversations, simulated tools). Check run (`20261016-155413-eval-4347`, k=3, 72 conversations, $0.82). First summary said pass@1 0.60 and two promises "clearly break" (R8 12 of 15, R9 9 of 9).
- **That was wrong, and the harness again.** Reading the failures: every R8/R9 "break" was `check error: You've hit your session limit`. Mid-run, the account hit its rate limit; 24 conversations crashed, and the grader scored "couldn't check" as "broke". Fix: a check that can't run is marked as an error, not a failure; a trial whose judge hits a rate limit is rerun like any infra failure; crashed trials are left out of every rate and shown as a separate count. `tripwire summarize <run>` recomputes old runs for free.
- Corrected: 48 usable conversations, pass@1 0.90 (likely 0.70–0.97), pass^3 0.81. Four promises hold, R1/R2 flaky (1 break each), R5 broke 3 of 9 (not enough data to be sure), R9 has no usable data at all.
- *Lessons: (1) "couldn't measure" must never look like "failed": the scariest red in the report was an outage. (2) Read the failing transcripts before believing a verdict; this is the third time the harness, not the agent, was the story. (3) With 3 conversations per promise, most verdicts are still "not sure yet".*

## Open problems

- Too few cases per rule → attribution mostly "unclear". Need 3–4 per rule.
- Simulator and judge are uncalibrated (no human labels yet).
- Paylane brief came from a company take-home: replace or rename that scenario before going public.
