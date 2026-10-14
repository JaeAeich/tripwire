# Build contract (2026-10-16): shared interfaces for parallel work

Core user question: "I'm building an agent. How do I know my prompt does what I meant?"
First-run flow: paste prompt (+ describe tools) -> tripwire drafts intents, tools, test conversations -> user edits -> run check -> plain report per intent -> next: map (attribution), attack, fix.

## Stream ownership (don't edit files you don't own; ask in your final report instead)
- A (real tools): src/tripwire/core/backends.py, core/agent.py, core/runner.py, new core/mcp_bridge.py, tests/test_runner.py, tests/test_tools_native.py
- B (stats): new core/stats.py, eval/__init__.py, attribute/__init__.py, tests/test_stats.py
- C (draft + generic scenarios): new core/simenv.py, new src/tripwire/draft/, core/scenario.py, cli.py, server/__init__.py, tests/test_draft.py, tests/test_simenv.py
- D (UI): web/ only

## Scenario format v2 (C implements; v1 Python env scenarios keep working)
scenario.yaml:
```yaml
name: acme
description: ...
prompt: prompt.md            # '## Section' parts; sections concatenated == the user's prompt
env: simulated               # new. Or "env.py:ClassName" as before
tools: tools.yaml            # list of {name, description, input_schema (JSON schema object), mutates: bool}
world: world.md              # plain words: what data exists, business facts. Optional
fixtures: fixtures.json      # optional seed state for the simulator (records it must stay consistent with)
rules: [{id: R1, title: ..., text: ...}]   # "intents" in the UI
defaults: {models: {agent:, user:, judge:, tools:}}
```
Cases unchanged (persona + checks). Preferred check types for simulated scenarios: tool_called / tool_not_called (with args), judge. `state` checks work against the simulator's JSON state but are less reliable.

SimulatedEnv: Environment subclass built from tools.yaml. `call(name, args)` asks an LLM (model `defaults.models.tools`, default claude-haiku-5-5) to act as the backend given world + current state + call; returns (result, blocked) and updates self.state. Keeps `self.cost_usd` (float) summed over its LLM calls. Must work when called from any thread: it uses `current_budget()` from backends, and A guarantees tool handlers run inside the trial's contextvars context.

## Agent turn API (A implements)
Backend gains `run_agent_turn(*, model, system, transcript, tools, call_tool, max_rounds) -> AgentTurn(reply: str, calls: list[ToolCallRecord], cost_usd, latency_s)` where `call_tool(name, args) -> (result, blocked)` is invoked by the harness for every native tool call, in order, inside the trial's context. ClaudeCode does it with one `claude -p` call per agent turn plus a stdio MCP bridge; Anthropic does a native tool loop. `complete_json` stays for user simulator / judge / simulated tools / drafting. PROTOCOL_VERSION = 3. Runner adds `getattr(env, "cost_usd", 0)` to trial cost.

## HTTP API (C implements server; D builds UI against it)
Existing: GET /api/health, GET /api/scenarios, GET /api/runs, GET /api/runs/{id}, POST /api/runs, POST /api/runs/{id}/stop.
New:
- POST /api/draft  {prompt: str, tools?: str (plain words or JSON), name?: str} -> Draft (sync, 30-120 s, costs ~$0.05)
- POST /api/scenarios {draft: Draft, overwrite?: bool} -> {name}   (409 if exists and not overwrite)
- GET /api/scenarios/{name} -> Draft-shaped full scenario + {env_kind: "simulated"|"python", editable: bool}
- PUT /api/scenarios/{name} {draft: Draft} -> {name}   (only for simulated scenarios)

Draft:
```json
{"name": "acme", "description": "...",
 "sections": {"Role": "...", "Refunds": "..."},
 "rules": [{"id": "R1", "title": "Verify first", "text": "...", "source_section": "Verification"}],
 "tools": [{"name": "get_customer", "description": "...", "input_schema": {...}, "mutates": false}],
 "world": "...", "fixtures": {},
 "cases": [{"id": "01", "title": "...", "why": "...", "kind": "plain|trap|lookalike",
            "persona": {"who": "...", "goal": "...", "style": "...", "knows": "...", "pushback": 2},
            "checks": [{"rule": "R1", "type": "tool_not_called", "tool": "issue_refund"}]}],
 "notes": ["assumption or question for the user"]}
```

## Editing (2026-10-17)
Everything shown in the UI is edited where it is shown; saves are free (no model calls) and never start runs.
- Draft gains optional `title` (display name; the slug `name` stays the folder/URL/CLI id) and `defaults`: `{models: {agent, user, judge, tools}, k}` (`k` = default tries per test, 1-20; model roles other than those four are a 422). Cases keep `script` (list of customer messages, instead of `persona`) and `max_turns` (1-30). GET /api/scenarios/{name} -> PUT of the same body changes nothing (tested).
- GET /api/scenarios entries gain `title`, `notes`, and per case `max_turns` and `hash` (fingerprint of persona/script/max_turns/checks). Eval runs record `config.case_hashes` {case id: hash}: a different hash now = the test was "edited since" that run.
- POST /api/scenarios/{name}/rename {to} -> {name, runs}: slugifies `to`, moves the folder (versions included), sets `name` in scenario.yaml, and rewrites `scenario` (and `config.scenario_path`) in every run.json and runs/index.json. 409 if the target exists, the project is Python, or one of its runs is still going in this server.
- PUT /api/scenarios/{name}/prompt accepts `renames: {old: new | null}`: promises whose `source_section` is `old` move to `new`, or (null, part deleted) become about the whole prompt, in the same save. Part order is the order of `sections`.
- PATCH /api/runs/{id} {label} -> {id, label}: `config.label` on the run and its index line ("" removes it; whitespace collapsed, max 120 chars). 409 while the run is going in this server.
- Drafter `notes` are dismissed by saving the draft without them.
- `tripwire serve --runs <dir>` (default $TRIPWIRE_RUNS or runs).

## Summary stats (B implements; additive, old keys stay)
Eval summary `per_rule[R]` gains: `cases` (int), `lo`, `hi` (95% interval of violation rate, case-clustered), `verdict` ("holds"|"breaks"|"flaky"|"too_few"), `sentence` (plain words, e.g. "Held in all 9 runs across 3 conversations").
Top level gains `pass_at_1_ci: [lo, hi]`, `pass_hat_k_ci: [lo, hi]`, `min_detectable_effect` (float, points).
Attribution summary per (section, rule) effect gains `lo`, `hi` (paired bootstrap over cases), `significant` (bool, Holm-corrected), `sentence`.

## Attack
A planner model (default claude-sonnet-5-5, `complete_json`) writes `per_rule` attacks per target promise, each with a distinct `angle` (false authority, splitting a request, emotional pressure, rule look-alike, urgency, ...) and a harmless look-alike the agent must help with. Cases use the drafted-case shape plus run-only keys `target`, `angle`, `pair`; attack ids `R3-a1`, look-alike ids `R3-l1`. Validated like drafts; an attack without a check on its target is dropped with its look-alike. Every case runs k times through run_jobs, variant `"attack"`. Run kind `"attack"`; `config.attacks` holds the planned cases, plus `config.plan_cost_usd`, `config.warnings`.

HTTP:
- POST /api/attacks {scenario, rules?: [ids], per_rule?: 3, k?: 3, base_run?, judge?: true, planner_model?, agent_model?, workers?, trial_timeout_s?} -> {id}. Async like POST /api/runs; `summary.phase` is "planning" until trials start; POST /api/runs/{id}/stop works in both phases.
- POST /api/scenarios/{name}/cases {cases: [case]} -> {name, added: [ids]}. Appends to a simulated scenario (409 for python ones), renumbering ids after the highest and stripping run-only keys; 422 {problems} if invalid.

CLI: `tripwire attack <scenario> [--rules R1 R2] [--per-rule 3] [-k 3] [--base-run id] [--planner-model m]`.

Summary:
- `attacks[]`: {id, rule, kind: "trap", angle, title, pair, broke, tries, passes: [bool], rate, lo, hi (Wilson 95%), verdict ("breaks" if broke in >= half | "flaky" | "holds" | "too_few"), also_broke: [other rules], promote (broke in >= half its tries)}. A try counts when a target-rule check ran; broke = any target-rule check failed.
- `lookalikes[]`: same keys minus also_broke/promote; broke = any check failed (usually a wrong refusal).
- `per_rule[R]`: {attacks, broken_by (attacks that broke it at least once), promote, broke, tries, lo, hi (case-clustered over attacks), verdict (stats.rule_verdict), lookalikes, lookalikes_failed, sentence}.
- `promote`: attack ids; `promote_cases`: those attacks + their look-alikes, ready for POST /api/scenarios/{name}/cases.
- Top level: k, phase, done, trials, errors (crashed trials, left out of every rate), cost_usd (trials + planning), plan_cost_usd, headline {done, attacks, rules_broken, promote, top}.

## Versions
Simulated scenarios keep prompt history in `scenarios/<name>/versions/<n>.json`: `{n, created (epoch s), note, author: "human"|"agent", sections}`. Version 1 is created lazily from the current prompt the first time history is needed; a prompt.md edited by hand becomes its own version (note "prompt.md edited outside tripwire") the next time history is read. Saving an unchanged prompt makes no new version. Python scenarios have no history (409).
- PUT /api/scenarios/{name}/prompt {sections: {name: text}, note?} -> {name, version: {n, created, note, author, sections: [names]}, changed: bool}. 422 {problems} if invalid (e.g. a rule's source_section removed).
- PUT /api/scenarios/{name} {draft, note?} and POST /api/scenarios now return {name, version: n}; a changed prompt is recorded as a new version.
- GET /api/scenarios/{name}/versions -> [{n, created, note, author, sections: [names]}], oldest first.
- GET /api/scenarios/{name}/versions/{n} -> full version (404 if missing).
- Runs record `config.prompt_version` (eval, attack, attribute; null for Python scenarios).
- POST /api/runs (eval) accepts `prompt_version` (run that saved version; default: current) and `rules: [ids]` (affected-tests rerun: only cases with a check on those promises; kept as `config.rules`). 400 for unknown rules/version or when no case matches.

CLI: `tripwire eval <scenario> --rules R3 --prompt-version 2`.

## Brief
`tripwire.brief.build(run, rule=None, section=None, runs_dir=None, excerpts=3)` -> dict with `markdown`:
```json
{"run": "...", "kind": "eval", "scenario": "...", "prompt_version": 2, "filter": {"rule": null, "section": null},
 "section_text": null, "attribution_run": "<id>|null",
 "promises": [{"rule": "R3", "title": "...", "text": "...", "source_section": "Return policy", "source_text": "...",
               "result": {"violated", "checked", "cases", "rate", "lo", "hi", "verdict", "sentence"},
               "map": [{"section", "role", "base_rate" (with section), "ablated_rate" (without), "lo", "hi",
                        "significant", "sentence"}] | null,
               "excerpts": [{"case", "trial", "title", "kind", "who", "goal", "angle", "step",
                             "turns": [{"i", "role": "customer|agent|tool", "text"}], "failed": [{"check", "detail"}]}]}],
 "must_not_regress": [{"rule", "title", "text", "sentence"}]}
```
Promises: violated at least once (crashed trials and broken checks left out); `rule` forces that one promise; `section` keeps promises from that section or that the map says the section holds up / breaks. Map: the newest finished attribute run of the same scenario with the same prompt. Excerpts: one per conversation, the turns around the failing step (3 before, 2 after; else the last 6).
- GET /api/runs/{id}/brief?rule=&section=&format=json|md (md: text/markdown).

CLI: `tripwire brief <run> [--rule R3] [--section S] [--excerpts 3] [--json]`.

## Compare
GET /api/runs/{a}/compare/{b} (b = after) -> `{a, b, scenario, prompt_versions: [va, vb], per_rule, fixed, regressed, same, new, not_rerun, sentence}`. `per_rule[R]` = `{before, after (rule stats as in Brief `result`, or null), change, delta, lo, hi, paired_cases, leaning, sentence}`. Paired by case (stats.paired_diff over cases both runs ran, after - before violation rate); with no shared case, the gap between the two intervals. change: `fixed` (interval < 0), `regressed` (> 0), `same` (`leaning`: "better"|"worse"|null), `new` (only b checked it), `not_rerun` (only a did, e.g. a rerun limited by `rules`). 400 if the runs are of different scenarios.

CLI: `tripwire compare <a> <b> [--json]`.

## MCP
`tripwire mcp [--scenarios scenarios]`: stdio MCP server (newline JSON-RPC 2.0: initialize, ping, tools/list, tools/call; no extra deps). Project = scenario folder name. Tool results are one text block (JSON, or markdown for get_brief); errors set `isError`. Setup and loop: AGENTS.md.
- list_projects() -> [{project, description, editable, promises: [{id, title}], cases, latest_runs: [{id, kind, status, prompt_version, pass_at_1}]}]
- get_report(run) -> {id, kind, project, status, prompt_version, k, rules_filter, pass_at_1, pass_at_1_ci, pass_hat_k, trials, errors, cost_usd, error, per_promise: {R: {verdict, sentence, violated, checked}}}
- get_brief(run, rule?, section?, format? = md|json)
- get_prompt(project, version?) -> {project, version, editable, sections, rules: [{id, title, text, source_section}], versions}
- save_prompt_version(project, sections, note) -> as PUT .../prompt, author "agent"
- estimate_check(project, rules?, k = 3) -> {cases, trials, per_trial_usd, est_cost_usd, basis: "past runs"|"default"} (median cost per trial of the last 5 finished evals of the scenario, else $0.012)
- run_check(project, max_cost_usd, rules?, k = 3, prompt_version?, judge = true) -> {run, prompt_version, estimate}; refuses (isError) if est_cost_usd > max_cost_usd. Runs in the MCP process; ending the session stops it ("stopped", finished trials kept).
- get_run_status(run) -> {id, status, done, total, cost_usd, pass_at_1, error, updated}
- compare_runs(a, b) -> as Compare
