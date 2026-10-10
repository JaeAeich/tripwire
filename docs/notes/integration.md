# Integration and tech stack (subagent sweep 2026-10-16)

Bottom line: no standard way exists to swap the prompt inside someone else's agent, so v1 makes the prompt a parameter of the agent call. Fake tools with a stateful LLM simulator; add record/replay of real tool traffic later.

## Frameworks
- **OpenAI Agents SDK:** tracing and LiteLLM model routing documented. Prompt swap via `Agent.clone(instructions=...)` [unverified].
- **Claude Agent SDK:** `systemPrompt` option plus in-process tools via `createSdkMcpServer()`. Mature, good fit.
- **Pydantic AI:** `Agent.override(model, deps, toolsets)` is built for tests; docs list no prompt override.
- **Google ADK:** ships its own LLM user simulator and eval sets (overlaps with us).
- **Mastra:** has scorers.
- **Vercel AI SDK:** OpenTelemetry traces via `experimental_telemetry`.
- **LangGraph, CrewAI:** prompts hard-coded in nodes or role fields; swapping needs config injection [unverified].
- **Agent as an endpoint:** promptfoo providers (HTTP, Python `call_api`, `exec:`) plus its trace receiver for asserting on tool paths. The dominant pattern.

## Faking tools
- **MCP:** the standard; 2026-07-28 spec moves to a stateless request/response core.
- **Record/replay:** young tools (mockmcp, MockServer, Witness).
- **LLM-simulated tools:** ToolEmu 2309.15817, Simia 2511.01824 (good enough to train on, tested on tau2), GTM 2512.04535, MTR 2510.06825.
- **Schema-generated deterministic fakes:** VULCAN (ICLR 2026 submission).
- **Stateful Python env with shared DB:** tau2 style; what tripwire does now.

## Observability
- **OpenTelemetry GenAI conventions:** still "Development"; moved to their own repo June 2026. Pin a version.
- **OpenInference** (Arize): de facto alternative attribute set.
- **Traces to test cases:** Langfuse "Add to dataset"; Braintrust and LangSmith similar.

## Registries and CI
- **LangSmith:** prompt commits and tags (`pull_prompt("name:prod")`).
- **Braintrust:** `eval-action` comments results on the PR; failing on a score threshold needs a custom reporter.

## Models and cost
- **LiteLLM:** multi-provider standard; cost helper `completion_cost` [unverified].
- **OpenRouter BYOK:** free to $25k/month, then 5%.
- **Batch APIs:** ~50% off, stacking with caching (Anthropic cache reads ~90% off). Ablation and evolution share long prompt prefixes, so caching pays. Batch only suits single-turn grading.

## Recommended architecture
**v1**
- **Prompt in:** from a file, git path or registry pull; split into sections.
- **Tools in:** MCP tool list or OpenAI/Anthropic JSON schemas, plus optional sample responses.
- **Runner:** tripwire's own loop via LiteLLM on the user's keys.
- **Fake tools:** stateful LLM simulator grounded in schemas and sample data; log every response for exact replay; consistency checks.
- **CI:** CLI that writes JSON, a GitHub Action, non-zero exit below a score threshold, per-run cost.

**v1.5**
- **Bring your agent:** an adapter that takes `(system_prompt, messages, tool_endpoint)`; tripwire hands the agent an MCP server it controls.
- **Ready-made adapters:** Claude Agent SDK, OpenAI Agents SDK, Pydantic AI.

**Later**
- Record/replay proxy in staging, falling back to the LLM simulator.
- Ingest OpenTelemetry/OpenInference traces: failing production conversations become scenarios.
- VULCAN-style deterministic fakes for high-stakes tools.
- Batch API for grading passes.

**Choosing how to fake tools**
- **LLM simulator (default):** zero setup, covers adversarial edge cases; drifts, so keep state and logs.
- **Schema + sample data:** when correctness matters (payments, record IDs).
- **Record/replay:** most realistic; breaks on queries never recorded.
