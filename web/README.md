# tripwire web

The UI for tripwire: eval runs, transcripts, attribution heatmaps and scenarios.
Vite + React + TypeScript, plain CSS, hash router. It only reads the trace format
(`src/tripwire/core/trace.py`); it never imports Python.

Needs Node 20+ and pnpm.

```
cd web
pnpm install
```

## Local mode (live, can start runs)

Start the API from the repo root, then the dev server:

```
uv run tripwire serve          # http://127.0.0.1:8787
cd web && pnpm dev             # http://localhost:5173, /api is proxied to 8787
```

You can start an eval from the home page and an attribution from an eval run page.
Running runs refresh every 2 seconds.

`tripwire serve` also serves `web/dist` if it exists, so after `pnpm build` the
whole thing runs from http://127.0.0.1:8787 without the dev server.

## Static mode (read-only demo, GitHub Pages)

When `api/health` does not answer, the UI reads a snapshot instead:
`./data/index.json`, `./data/scenarios.json`, `./data/runs/<id>.json`.
New-run controls are hidden and the header shows "demo, read-only".

```
uv run tripwire serve          # repo root, only needed to take the snapshot
cd web
pnpm snapshot                  # finished runs -> public/data (add --all for running ones)
pnpm build                     # dist/ includes data/
```

Asset paths are relative by default, so `dist/` works under any sub-path.
Set `BASE_URL` if you need an absolute base, e.g. `BASE_URL=/tripwire/ pnpm build`.
To try it locally: `python3 -m http.server -d dist 4174`.

## Dev fixture

`src/dev-fixtures/attribution.sample.json` is a fictional attribution run (made with
tripwire's own `summarize()`) for building the attribution view before a real one
exists. It is linked from the home page only under `pnpm dev`, at
`#/runs/dev-fixture-attribution`, and is never included in a production build.

## Mock mode (no backend at all)

```
VITE_MOCK=1 pnpm dev           # every API call is answered in the browser by src/dev-fixtures/mock.ts
```

Seeds two projects: `paylane` (the real scenario and one real eval) and `kettle-returns`, a drafted
e-commerce returns agent (`src/dev-fixtures/returns.ts`) with three checks and a "which part" run.
`Check a prompt` drafts in ~9 s (`VITE_MOCK_DRAFT_MS` to change) and always returns the kettle draft.
Runs you start play out at about one conversation per second. Saved projects and started runs live in
localStorage (`tw-mock`); clear it to reset. Add `live=1` to any URL's hash for a run that is in progress.
`#/check?example=1&autostart=1` starts drafting on load (mock only), handy for screenshots.
The mock is only imported when `VITE_MOCK=1`, so it never ends up in a normal build.

## The flow

`/` workspace (project health) → `/check` paste a prompt → `/check/review` edit the drafted parts, promises, tests and
setup, save, run → `/runs/:id` report per promise.

Each project (`/scenarios/:name`) has one tab per step of the loop:
Overview · Prompt · Tests · Runs · Map · Attack · Fix · Setup.

- **Overview** leads with what needs attention, then a promise × check grid.
- **Prompt** is the workbench: labelled underlines, an evidence panel beside the prompt (`?p=R3`: failing excerpts,
  map numbers, "Copy for an agent"), prompt versions, edit a part and rerun only the affected tests.
- **Tests / Setup** edit tests, tools, the simulated world, seed data and models in place.
- **Attack** runs aimed attacks and adds the ones that broke a promise as tests. **Fix** is a preview.
- Promise and test pages: `/promises/:id`, `/tests/:id`. Compare two checks: `/runs/:id/vs/:other`.

Everything shown is editable where it's shown (`components/Editable.tsx`: click, Enter saves, Esc cancels, no layout
shift). Python projects are read-only. The sidebar collapses with `[`.

## Scripts

| script | what |
|---|---|
| `pnpm dev` | dev server with the API proxy |
| `pnpm build` | type check and build to `dist/` |
| `pnpm preview` | serve the build (still proxies `/api` if the API is running) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm snapshot` | save a static snapshot from a running API |

## Layout

```
src/lib/        api.ts (one fetch module: local, static, mock), types.ts, hooks.ts, format.ts,
                words.ts (plain-words checks, verdicts, estimates), anchor.ts (which part/sentence a promise
                comes from), projects.ts, draftStore.ts, example.ts
src/components/ Doc.tsx (the prompt as a document + margin notes + side panel), Transcript, TrialGrid,
                Heatmap, promise.tsx (verdict chip, interval bar, tests by promise), LivePanel (run bar), ScoreChart
src/pages/      Home, NewCheck, ReviewDraft, Project (overview, prompt, promise, test, compare), EvalRun (report),
                TrialPage, AttributionRun (map), Attack, Loop (fix), ScenarioPage (tests, runs, map, setup)
src/styles/     tokens.css (paper palette, type), app.css
src/dev-fixtures/ mock.ts + fixtures for VITE_MOCK=1
```

Styling: `styles/tokens.css` defines everything once: Radix Colors (sand, red, amber, grass, blue; steps used by
their documented roles) and the Radix Themes space / font-size / radius scales. `app.css` uses only those tokens.
There is one chip (`components/Chip.tsx`: holds, breaks, flaky, unsure, skip, neutral), one button set
(`btn-ink`, `btn-line`) and one card style. Explanations live behind a "?" (`Help`) or in the side panel.

The design idea: the prompt is the page. Report, map, review and project pages all render the prompt with
`PromptDoc`; each promise sits in the right margin next to the part it comes from, its source sentence gets a
spell-check style underline (red wavy = breaks, amber dashed = flaky, dotted = not sure), and hovering a note
highlights that sentence. Clicking a promise opens a side panel (`?p=R3`) with its tests, tries and the
failing steps. Conversations that couldn't run and checks that couldn't be made are grey and never count as
failures. Set `PORT` to pin the dev server port.
