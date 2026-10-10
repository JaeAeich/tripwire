# Market (subagent sweep 2026-10-16; stars live from GitHub API, pricing mostly from aggregators)

Bottom line: evals and tracing are commoditized; nobody owns "which part of my system prompt causes this failure". Lead with attribution, use simulated customers to produce failures, treat evolution as later.

## Eval + observability platforms (consolidating; eng buyers, PM seats later)
- **Braintrust:** Pro $249/mo; $80M Series B at $800M (Feb 2026); closed SaaS.
- **LangSmith:** $39/seat; LangChain $125M at $1.25B (Oct 2025).
- **Langfuse:** OSS, ~36k stars; Core $29/mo; acquired by ClickHouse Jan 2026.
- **Arize Phoenix/AX:** Phoenix 11.9k stars; $70M Series C (Feb 2025).
- **Opik (Comet):** Apache-2.0, 22.6k stars.
- **DeepEval / Confident AI:** 18.9k stars; "pytest for LLMs".
- **Galileo:** Cisco acquisition Apr 2026.
- **Humanloop:** team to Anthropic Aug 2025 (no IP); platform shut down [unverified].

## Red team (security and platform buyers)
- **promptfoo:** MIT, 26k stars; $18.4M Series A, then OpenAI acquisition (Mar 2026). Started as a solo side project.
- **Haize Labs:** ~$25M raised [unverified].
- **Giskard:** 5.9k stars, ~$8M raised.
- **garak (NVIDIA):** 9.6k stars.

## Agent and customer simulation (hottest, mostly closed)
- **Patronus:** $50M Series B [unverified]; moved to simulation environments.
- **Collinear**, **Guardrails Snowglobe** (gated beta).
- **Voice:** Coval ($28M Series A), Hamming (~$4M seed), Cekura (YC F24).
- **Smaller:** Maxim, Scorecard, Okareo.
- **LangWatch Scenario:** OSS user-simulator library, ~1k stars.
- **Built into support platforms:** Sierra (sims generated from SOPs, Voice Sims), Intercom Fin. These won't sell standalone tools.

## Prompt optimization
- **DSPy:** 38.7k stars.
- **GEPA:** 7k stars in ~14 months (grew from a paper plus DSPy integration).

## Commoditized
Tracing, LLM-judge scorers, datasets and experiments, prompt versioning, CI evals, red-team probe libraries, basic simulated-user loops.

## Open space
1. **Prompt-section attribution:** existing tools attribute to retrieved context (larpie), trajectory steps (agent-replay, AgentDebugX) or between agents (2505.00212). Only a May 2026 blog post on "prompt credit assignment" covers it, with no tool.
2. **Rule-targeted adversarial customers.**
3. **Statistically honest results:** repeated trials and CIs.
4. **Closed loop:** attribution -> evolution -> held-out gains.

## Positioning suggested
- **Pitch:** "git bisect for system prompts: find which section breaks which rule."
- **Shape:** OSS CLI/library on top of the existing stack; read prompts and OTel traces; export to Langfuse, promptfoo, DeepEval.
- **Output:** section×rule heatmap with CIs.
- **Job-hunting angle:** the infra story — deterministic replay cache, budget-aware parallel scheduling, statistical stopping, cost per insight.

## Go-to-market
1. **Flagship blog post** on a public agent (tau2-bench airline/retail): heatmap plus a surprising finding, with real numbers and cost.
2. **Show HN:** `pipx install`, 60-second GIF, static demo site.
3. **Discoverable integrations:** promptfoo provider, Langfuse export, DSPy/GEPA hook; awesome-lists; community channels.
4. **Product later:** buyer = AI-eng lead at a support-agent company; attribution as CI checks; open-core with a hosted runner; acquisition is the realistic exit.
