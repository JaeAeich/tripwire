# Letting a coding agent improve your prompt

`tripwire mcp` exposes the improve loop as MCP tools, so Claude Code (or any MCP client) can do what you would do in the UI: read the evidence, edit the prompt, save a version, rerun the promises it touched, and check nothing else broke. Every save is a prompt version (author "agent"), so you can see and undo what it did. Tool shapes: CONTRACT.md "MCP".

## Plug it in

From the repo root:

```sh
claude mcp add tripwire -- uv run tripwire mcp
```

Options: `--scenarios <dir>` after `mcp` (default `scenarios`), `TRIPWIRE_RUNS=<dir>` (default `runs`), `--backend claude-code|anthropic` before `mcp` (e.g. `uv run tripwire --backend anthropic mcp`). Only simulated scenarios can be edited; Python ones are read-only.

## The loop

1. `list_projects` -> pick a project and its latest eval run.
2. `get_brief(run)` -> failing promises, the section each comes from, the map (which section holds it up or causes the failure, if an attribution run exists for that prompt), a few failing conversations cut around the failing step, and the promises that hold now (must not regress).
3. `get_prompt(project)` -> edit as few sections as possible, in plain words. Fix the rule, not one case by name.
4. `save_prompt_version(project, sections, note)` -> pass all sections; the note says what changed and why.
5. `estimate_check(project, rules=[the ones you touched], k=3)`, then `run_check(..., max_cost_usd=...)`. Poll `get_run_status` until it isn't "running".
6. `compare_runs(old, new)` -> per promise fixed / regressed / same. A rerun limited to some promises shows the rest as `not_rerun`.
7. Before calling it done: run a full check (no `rules`) and compare again, so promises held up by other sections didn't regress.

Spend: every check costs real money; `run_check` refuses when the estimate is over `max_cost_usd`. A good first instruction: "Use tripwire to fix R3 in threadbare-returns. At most $0.50 per check, $2 total. Show me the diff and the compare before you stop."

Read results the way the UI does: "same" means can't tell yet, not "no effect"; crashed trials are left out of every rate; with 2-3 conversations per promise most changes will be "same", so add cases rather than trials.

Checks run inside the `tripwire mcp` process. Ending the Claude Code session stops them (status "stopped", finished trials kept).
