# How people use tripwire, screen by screen (web UI, direction B)

Written 2026-10-17 before the round-4 redesign. Each step: what the person needs to see or do, and whether the UI
on branch `worktree-agent-a9c09b7c762f405c8` (commit c16c51b) supports it. **Gap** marks what is missing or weak.

Words used below: a *project* is one agent prompt (a scenario); a *promise* is a rule the prompt makes; a *test* is
a scripted customer conversation (case); a *check* is an eval run; the *map* is an attribution run; an *attack* is
an attack run.

## a. First time

| # | Step | Needs | Today |
|---|------|-------|-------|
| 1 | Installs, runs `tripwire serve`, opens the UI. | To land in the app, not a landing page. To know it's connected to their machine. | OK: app shell with a rail; rail foot says "Local · tripwire serve". |
| 2 | Empty workspace. | One obvious next step: create a project. A short line on what a project is. Try-the-example as a second option. | **Gap**: the rail has "New check", not "New project"; the empty state is a dashed box with one button. No word on what happens next. |
| 3 | New project: paste the prompt, describe the tools, name it. | A big page to paste into, parts detected as they type, tools box, cost and time of drafting. | OK (`/check`), but it's called "check a prompt": **gap** in naming. It is really "new project". |
| 4 | Drafting wait, 30 s to 2 min. | Progress they can trust, cancel, nothing runs yet. | OK: the prompt stays on the page, stages in the margin, Cancel. |
| 5 | Review promises and tests. | Promises next to the part they come from; edit / delete / add; each promise's tests; the drafter's questions; tools and world. | OK. Prompt text itself can't be edited here (fine at this point). |
| 6 | Run the first check. | Tries per test, conversations, cost and time before pressing go. | OK (dock at the bottom). |
| 7 | Live progress. | Progress, cost so far, time left, Stop, peek at live conversations; results filling in as they come. | OK (run bar). |
| 8 | Report. | Headline per promise (holds / breaks / flaky / not sure), pass rate with range, cost, conversations that couldn't run, where each promise lives in the prompt. | OK. |
| 9 | Open a failing conversation at the failing step. | From a broken promise to the exact step, with why it failed and what the customer was told. | OK (side panel → "Read the conversation" → step highlighted). |
| 10 | Map: which part causes it. | One click from the report; cost first; result in the same document view. | OK (Find the cause → map tab). |
| 11 | Attack. | Pick promises, cost, live, results per attack, add winners as tests. | OK (Attack tab). |
| 12 | Fix (preview). | What it will do, honest "coming soon". | OK (Fix tab preview). |
| 13 | Edit the prompt itself. | Change a part of the prompt and save a new version, see which promises come from that part. | **Gap**: the editor edits promises and tests only; the prompt text is read-only. No notion of versions. |
| 14 | Re-run. | One button after saving; same tries as last time. | Partial: "Run check" exists, but nothing links the edit to the re-run. |
| 15 | Compare with the last run. | Per promise: fixed / regressed / same, with numbers; which prompt parts changed between the two runs. | **Gap**: no compare screen at all. |

## b. Returning user

| # | Step | Needs | Today |
|---|------|-------|-------|
| 1 | Opens the workspace. | Each project's health at a glance, and whether it got better or worse since the run before; what ran recently; anything running now. | Partial: cards show the latest verdict counts and pass rate. **Gap**: no trend, no "regressed" signal. |
| 2 | Opens a project. | How every promise has done across runs (a promise × run grid), current status, recent runs. | **Gap**: the project opens on the prompt document with the latest verdicts only. History is a separate chart of the overall pass rate. |
| 3 | Drills into one promise. | Its text and source part, its tests, its result in every run, map findings about it, attacks against it. | **Gap**: only the side panel inside one report (one run). No promise page. |
| 4 | Drills into one test. | Who the customer is, what it checks, its result in every run (each try), links to transcripts. | **Gap**: the tests tab shows the latest check's tries only; no test page. |
| 5 | Reads a transcript. | Step-by-step, checks, state changes, previous / next failure. | OK. |

## c. Changed the prompt or the model

| # | Step | Needs | Today |
|---|------|-------|-------|
| 1 | Edits the prompt (or runs with another model). | A saved version they can point at; the model in each run is visible. | **Gap** for prompt edits (see a.13). Models are shown per run. |
| 2 | Re-runs. | Same as a.14. | Partial. |
| 3 | Looks at the difference. | This run vs the one before: per promise fixed / regressed / same / new; the pass-rate change and whether it's bigger than chance; which parts of the prompt changed; models that changed. | **Gap**: no compare. Runs store the prompt they ran with (`config.prompt`), so prompt diffs can be derived. |

## d. Team and CI

| # | Step | Needs | Today |
|---|------|-------|-------|
| 1 | Share a report. | A static copy anyone can open. | Exists in the CLI (`tripwire export` + static mode) but **gap**: nothing in the UI says so. |
| 2 | Put it in CI. | The exact command for this project, copyable. | **Gap**: nowhere in the UI. (`tripwire eval <scenario> -k 3`; a pass/fail threshold flag does not exist yet.) |
| 3 | Costs over time. | Spend per run and per project, over time. | Partial: run table shows cost per run; project header shows total spend. No chart. |

## Top gaps, in order

1. No project overview of promises across runs (the core "is it getting better?" view).
2. No promise page and no test page with history.
3. No run compare (fixed / regressed / same).
4. The prompt can't be edited in the UI, and there are no prompt versions to compare.
5. "New project" is called "New check"; the empty workspace doesn't lead anywhere obvious.
6. Workspace has no trend or regression signal.
7. Sharing and CI are invisible.

## What round 4 builds (all derived client-side from GET /api/runs and /api/runs/{id})

- Rail: **New project**; an empty workspace with the three steps and the example.
- Workspace: per project, health (latest verdicts), change since the run before (fixed / regressed), a small pass-rate
  trend, last run; recent activity; running now.
- Project **Overview** tab (new default): current status strip, a **promise × check grid** (one dot per promise per
  run, click to open that promise in that run), and recent runs.
- **Promise page** (`/scenarios/:name/promises/:id`): text, source part with the sentence, its result in every check
  (rate with range), its tests with tries per run, map findings, attacks against it.
- **Test page** (`/scenarios/:name/tests/:id`): customer, checks, every run's tries linking to transcripts.
- **Prompt** tab: the document with the latest verdicts; **versions** (each distinct prompt a run used, by date); edit a
  part and save (PUT /api/scenarios/{name}, simulated projects) then **Save and re-run**.
- **Compare** (`/runs/:id/vs/:other`): per promise fixed / regressed / same / new with both rates; pass-rate change;
  prompt parts that changed (as a diff); models that changed. Reachable from every report ("vs previous") and the
  runs table.
- **Share & CI**: in the project's "⋯" menu: copy `tripwire eval …`, `tripwire export …`, the brief command and the
  MCP tool list.

## Every screen: the question it answers, and its one primary action

Secondary actions live in the project's "⋯" menu (rename, copy the CLI / brief / export commands,
agent tools, compare with the previous check, open the map). Explanations sit behind a "?".

| Screen | Question it answers | Primary action (top right) |
|---|---|---|
| Workspace | Which project needs me? | New project |
| New project (`/check`) | What does my prompt say? | Draft the promises |
| Review draft | Did we read the prompt right? | Save and run check |
| Project · Overview | What needs attention, and is it getting better? | Run check |
| Project · Prompt (workbench) | Which line holds or breaks which promise, and why? | Run check (edit a part from its heading or the evidence panel) |
| Project · Tests | What do we test, and how did each test do? | Run check |
| Project · Runs | What ran, when, at what cost? | Run check |
| Report (a check) | How did this check go? | Find the cause (or Attack it, if nothing broke) |
| Compare | What got better or worse between two checks, and what changed? | Run check |
| Map | Which part of the prompt causes each failure? | Run check |
| Attack | What still breaks under pressure? | Start attack (in the setup panel) |
| Fix | What edit would fix the blamed part, and is it safe? | Suggest an edit |
| Promise page | How has this promise done over time? | Run check |
| Test page | How has this test done over time? | Run check |
| Conversation | What exactly happened? | Next failure |

## Fix a broken promise

### As a human (target: zero page changes from a red underline to the failing conversation)

| # | Step | Clicks | Page changes |
|---|------|--------|--------------|
| 1 | Open the project. Overview lists "Needs attention": R4 breaks. | 1 | 1 |
| 2 | Prompt tab. The line R4 comes from is underlined red with a label "R4 · breaks". | 1 | 1 |
| 3 | Click the line (or its label, or its margin note). The evidence panel opens beside the prompt: the promise, its range, the map numbers for this part ("with it broke 1 of 5; without it 4 of 5"), and each conversation where it broke: the customer, the step that broke it highlighted with the turn before and after, which check failed and why. | 1 | 0 |
| 4 | "Show the whole conversation": the transcript expands inside the panel. | 1 | 0 |
| 5 | "Edit 'Refunds'" in the panel: the part becomes editable in place, evidence still beside it. | 1 | 0 |
| 6 | "Save and re-run 4 tests (~$0.06)": saves a new prompt version and re-runs only the tests for promises from this part. | 1 | 1 (to the compare view) |
| 7 | Compare: per promise fixed / regressed / same against the previous check, with the diff of the edited part. Updates live while the re-run finishes. | 0 | 0 |

From the red underline to reading the failing step: **1 click, 0 page changes**. Whole loop: 6 clicks, 3 page
changes (two of them are choosing where to go). Before round 4: underline → report → side panel → "Read the
conversation" (4 clicks, 2 page changes) and no way to edit the prompt at all.

### As an agent (or a human handing it to one)

| # | Step | Clicks | Page changes |
|---|------|--------|--------------|
| 1 | Same as human steps 1–3: open the evidence for R4. | 3 | 2 |
| 2 | "Copy for an agent": a self-contained markdown brief (promise, verdict and range, the prompt part, map numbers, every failing excerpt with the failed check, what must not regress, the command to verify). "Copy JSON" gives the same as data. | 1 | 0 |
| 3 | The agent proposes an edit (outside, or via the planned MCP tool `propose_edit`). | 0 | 0 |
| 4 | Or in the UI: Fix tab → pick the target → "Suggest an edit": the diff appears; Accept / Edit first / Reject. | 2 | 1 |
| 5 | Accept re-runs only the affected tests and opens the compare view. | 1 | 1 |

Headless: `tripwire brief <run> --rule R4` prints the same brief; the MCP server exposes `list_promises`, `brief`,
`propose_edit`, `rerun_affected` (planned, backend in progress; the UI shows the commands in the "⋯" menu).

Backend wishes (not built, described for the server owner): a stored prompt version id per run (today versions are
inferred by comparing `config.prompt`), and a `--fail-under` flag on `tripwire eval` so CI can gate on a pass rate.
