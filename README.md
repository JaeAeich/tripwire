# tripwire

**git bisect for system prompts.** You give an agent a prompt full of rules ("refund only to the original card", "check the order before discussing it"). tripwire tells you which rules it actually keeps, which line of the prompt holds each one up, which line breaks it, what kind of customer breaks it, and whether your fix made things better or just different.

![A project: what needs attention, and every promise across every check](docs/img/overview.png)

## What it does

The loop, one tab each in the UI:

1. **Draft.** Paste a system prompt. tripwire splits it into parts, drafts the *promises* (rules) it makes, the tools it implies, a simulated world, and test conversations for each promise: ordinary customers, traps that push the agent to break the promise, and harmless look-alikes so "refuse everything" doesn't score well. You edit all of it in place.
2. **Check.** Each test runs *k* times against a simulated customer and simulated tools. Every promise gets a verdict: **holds**, **flaky**, **breaks** or **not sure yet**, with an interval, not just a percentage.
3. **Map.** Remove one part of the prompt at a time and rerun. If a promise breaks more without a part, that part **holds it up**; if it breaks less, that part **causes** the failure.
4. **Attack.** A planner writes customers aimed at one promise each, from a named angle (urgency, authority, a story), each paired with a harmless look-alike. Attacks that break a promise reliably become permanent tests.
5. **Fix.** Edit the blamed part in place, save it as a new prompt version, rerun only the tests that touch it, and compare per promise: **fixed**, **regressed**, or **no clear change**. Or hand the evidence to a coding agent over MCP and let it do the loop under a spend cap.

![The prompt is the page: underlines mark where promises break; the panel shows the failing conversation, step and check](docs/img/prompt.png)

## How it works

- **Simulated customer, simulated backend.** A model plays the customer from a persona (who they are, what they want, how hard they push back). The agent under test gets real tool calls through a small MCP bridge to `claude -p`. A third model plays the backend, staying consistent with the project's world description and seed data. Nothing real is called.
- **Code checks first, a judge only when needed.** Most checks read the tool log and final state: `tool_not_called`, `called_before`, `state`, `text_matches`. A reviewer model is used only for things code can't see, and it has to name the step where the promise broke.
- **Statistics for small samples.** The unit is the test, not the try. Rates come with case-clustered Wilson intervals. pass^k uses the unbiased per-case estimator. The map and compare use paired bootstrap differences over the same tests, with Holm correction across the whole map. "Not sure yet" is a real answer, and most cells are not sure until a promise has 3–4 tests.
- **Infra errors are not failures.** A conversation that crashed or a check that couldn't run (rate limits, timeouts) is rerun or left out of every rate and shown as its own count. It never shows up as a broken promise.
- **Everything is versioned.** Each prompt save is a version, and runs record which version they used. Tests are fingerprinted, so history shows when a test changed after a run.

![Every check over time, with cost and models](docs/img/runs.png)

## Quick start

No API key needed: by default tripwire runs models through Claude Code headless (`claude -p`) on your Claude subscription.

```sh
uv sync
cd web && pnpm install && pnpm build && cd ..
uv run tripwire serve            # UI + API on http://127.0.0.1:8787
```

Open the UI, click **New project**, paste a prompt. Or from the CLI:

```sh
uv run tripwire draft examples/prompts/threadbare.md         # prompt -> scenarios/threadbare/
uv run tripwire eval scenarios/kettle-returns -k 3           # check every promise, 3 tries per test
uv run tripwire attribute <run-id> -k 5                      # the map, on that run's failing tests
uv run tripwire attack scenarios/kettle-returns --per-rule 2 # aimed attacks + look-alikes
uv run tripwire brief <run-id>                               # evidence for a fix, as markdown (--json for agents)
uv run tripwire compare <run-a> <run-b>                      # per promise: fixed / regressed / same
uv run tripwire summarize <run-id>                           # recompute a run's numbers, free
```

With an API key instead: `uv sync --extra anthropic` and `--backend anthropic`, or set `ANTHROPIC_API_KEY`.

**Cost.** Every check spends real model calls, and the UI shows an estimate before anything runs. For reference: 30 conversations (6 tests × 5 tries) cost $0.27, and a 9-promise prompt with 72 conversations cost $0.82. Most of that is the Sonnet reviewer, not the agent. Drafting a project costs about $0.20.

**Limits.** Each conversation has a time budget (`--trial-timeout`, default 600 s). Model calls retry on timeouts and bad output (`--retries`). A trial that dies of an infra error is rerun (`--trial-retries`); a broken promise is never retried. Ctrl-C, or Stop in the UI, keeps the finished trials.

## Let a coding agent fix the prompt

```sh
claude mcp add tripwire -- uv run tripwire mcp
```

That gives the agent nine tools: list projects, read a report or a fix brief, read and save prompt versions, estimate and run a check (refused over `max_cost_usd`), poll it, and compare. Every save is a version with author "agent", so you can see and undo what it did. The loop and a good first instruction are in [docs/AGENTS.md](docs/AGENTS.md).

## A project is a folder

```
scenarios/kettle-returns/
  scenario.yaml   promises (R1..), default models, env: simulated
  prompt.md       the prompt, split into "## Part" sections
  tools.yaml      tools the agent can call, and whether each changes data
  world.md        what the simulated backend knows
  fixtures.json   seed data
  cases/*.yaml    a persona or a script, plus checks tied to promises
```

Drafted projects are fully editable in the UI. A project can also bring its own Python environment (`env.py`: tools as methods, state as JSON, custom checks). Those are read-only in the UI.

Check types: `tool_called`, `tool_not_called`, `called_before`, `state` (a path into the final state), `text_matches`, `text_not_matches`, `custom` (Python projects), `judge`.

## Layout

```
src/tripwire/core/       trace format, backends, MCP tool bridge, agent, simulated user and backend, graders, runner, stats
src/tripwire/draft/      prompt -> project drafting, validation, folder I/O
src/tripwire/eval/       per-promise verdicts, pass@1, pass^k
src/tripwire/attribute/  the map: part ablation with paired intervals
src/tripwire/attack/     planner, look-alikes, promotion to tests
src/tripwire/            versions, brief, compare, loop (the improve loop)
src/tripwire/server/     HTTP API for the UI, MCP server for agents
web/                     the UI (Vite + React + TypeScript); see web/README.md
```

## Docs

- [docs/JOURNEY.md](docs/JOURNEY.md): what we built, what broke, and what we learned, with real numbers.
- [docs/PRODUCT.md](docs/PRODUCT.md): who it's for and the build order.
- [docs/RESEARCH.md](docs/RESEARCH.md): the papers behind the method (τ-bench, ContextCite, GEPA, judge bias).
- [docs/UX-JOURNEY.md](docs/UX-JOURNEY.md): each screen's question and primary action.
- [docs/CONTRACT.md](docs/CONTRACT.md): the HTTP API and trace format.
- [docs/AGENTS.md](docs/AGENTS.md): driving tripwire from a coding agent.

## Status

Working: draft, check, map, attack, versions, compare, briefs, MCP, and in-place editing of everything in the UI. Not yet: an automatic fix suggester (the Fix tab is a preview), judge calibration against human labels, and a public demo scenario.

```sh
uv run pytest                    # no model calls
cd web && VITE_MOCK=1 pnpm dev   # the UI with no backend at all
```
