// Fix: the last step of the loop. Not built yet; this screen shows what it will do, with a preview made from the
// project's own promises and latest results (clearly marked as an example).
import { useState } from "react";
import { getScenario, savePrompt, startRun } from "../lib/api";
import { DiffText } from "./Project";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getRun } from "../lib/api";
import { bestSentence, placeRules, sentences } from "../lib/anchor";
import { useAppData, useScenario } from "../lib/context";
import { pct, plural } from "../lib/format";
import { useAsync, useDocumentTitle } from "../lib/hooks";
import { useRuns } from "../lib/projects";
import { runHref } from "../lib/routes";
import type { AttributionSummary, Cell, EvalSummary, Rule, RuleVerdict, Scenario } from "../lib/types";
import { readRule } from "../lib/words";
import { Loading } from "../components/bits";
import { partLabel } from "../components/Doc";
import { ProjectFrame, projectRuns } from "../components/ProjectFrame";
import { Help } from "../components/Stats";
import { Chip } from "../components/Chip";

export function useLatest(name: string) {
  const { runs } = useAppData();
  const mine = projectRuns(runs, name);
  const evalEntry = mine.find((r) => r.kind === "eval" && r.status !== "running");
  const mapEntry = mine.find((r) => r.kind === "attribute" && r.status === "done");
  const details = useRuns(evalEntry ? [evalEntry] : []);
  const map = useAsync(() => (mapEntry ? getRun(mapEntry.id) : Promise.resolve(null)), [mapEntry?.id]);
  const evalRun = evalEntry ? details[evalEntry.id] : undefined;
  const per = (evalRun?.summary as Partial<EvalSummary> | undefined)?.per_rule ?? {};
  const matrix = (map.data?.summary as Partial<AttributionSummary> | undefined)?.matrix ?? [];
  return { evalEntry, mapEntry, per, matrix, ready: !!runs };
}

export const verdictOf = (per: Record<string, { checked: number; violated: number; rate: number }>, id: string): RuleVerdict | null =>
  per[id] ? readRule(per[id]).verdict : null;

/** The title row of a loop step: name, a "coming soon" chip when it isn't built, and the explanation behind a "?". */
export function StepHead({ title, chip, help }: { title: string; chip?: string; help: string }) {
  return (
    <div className="toolbar">
      <h2 className="step-h">
        {title} {chip && <Chip>{chip}</Chip>} <Help>{help}</Help>
      </h2>
    </div>
  );
}

/** Where this step sits in the loop. */
export function Flow({ active, evalId }: { active: "attack" | "fix"; evalId?: string }) {
  const steps = [
    { id: "check", label: "Check", sub: "promises hold or break" },
    { id: "map", label: "Map", sub: "which part is to blame" },
    { id: "attack", label: "Attack", sub: "hostile customers, new tests" },
    { id: "fix", label: "Fix", sub: "edit the blamed part, prove it" },
  ];
  return (
    <ol className="flow" aria-label="The loop">
      {steps.map((s) => (
        <li key={s.id} className={s.id === active ? "is-on" : ""}>
          <b>{s.label}</b>
          <span>{s.sub}</span>
        </li>
      ))}
      {evalId && (
        <li className="flow-link">
          <Link to={runHref(evalId)}>Latest check →</Link>
        </li>
      )}
    </ol>
  );
}

// ---------- Fix ----------

export function ProjectFix() {
  const { name = "" } = useParams();
  useDocumentTitle(`${name} fix`);
  return (
    <ProjectFrame name={name} tab="fix">
      <FixTab name={name} />
    </ProjectFrame>
  );
}

interface Target {
  rule: Rule;
  section: string;
  why: string;
  cell?: Cell;
}

function targetsOf(scn: Scenario, per: Record<string, { checked: number; violated: number; rate: number }>, matrix: Cell[]): Target[] {
  const rules = Object.fromEntries(scn.rules.map((r) => [r.id, r]));
  const out: Target[] = [];
  // the map's culprits first (only for promises that still fail: an old map may describe a fixed problem)
  for (const c of matrix.filter((m) => (m.role === "culprit" || (m.role === "unclear" && m.delta <= -0.25)) && verdictOf(per, m.rule) !== "holds"))
    if (rules[c.rule] && scn.sections[c.section] !== undefined)
      out.push({ rule: rules[c.rule], section: c.section, cell: c, why: `The map says this part makes ${c.rule} break (${pct(c.base_rate)} with it, ${pct(c.ablated_rate)} without).` });
  const place = placeRules(scn.sections, scn.rules);
  for (const r of scn.rules) {
    const v = verdictOf(per, r.id);
    if ((v === "breaks" || v === "flaky") && place[r.id] && !out.some((t) => t.rule.id === r.id))
      out.push({ rule: r, section: place[r.id]!, why: `${r.id} ${v === "breaks" ? "breaks" : "is flaky"} and comes from this part.` });
  }
  return out;
}

/** The edit an agent would suggest for this target. Mocked: a real one comes from the planner backend. */
export function suggestedText(scn: Scenario, t: Target): string {
  const text = scn.sections[t.section] ?? "";
  const ss = sentences(text);
  const hit = bestSentence(text, t.rule) ?? (t.cell ? ss.length - 1 : null);
  const added = t.cell
    ? `Only offer this once the rule “${t.rule.title}” is met; never instead of it. `
    : `${t.rule.text.replace(/\.?$/, ".")} No exceptions, even if the customer insists or says it was already approved. `;
  if (hit === null) return `${text.trim()} ${added.trim()}`;
  return ss.map((s, i) => (i === hit ? (t.cell ? added : `${s}${s.endsWith(" ") ? "" : " "}${added}`) : s)).join("").trim();
}

export const SUGGEST_KEY = "tw-suggest";

function FixTab({ name }: { name: string }) {
  const scn = useScenario(name);
  const { mode, reloadScenarios, reloadRuns } = useAppData();
  const nav = useNavigate();
  const detail = useAsync(() => getScenario(name), [name]);
  const { per, matrix, mapEntry, evalEntry, ready } = useLatest(name);
  const [pick, setPick] = useState(0);
  const [state, setState] = useState<"idle" | "thinking" | "ready" | "busy">("idle");
  const [err, setErr] = useState<string | null>(null);
  if (!scn || !ready) return <Loading what="project" />;
  const targets = targetsOf(scn, per, matrix);
  const t = targets[Math.min(pick, targets.length - 1)];
  // the agent backend is being built; the mock shows the whole loop
  // the suggestion itself is a browser-side preview; saving and re-running are real
  const canSuggest = mode === "local" && !!detail.data?.editable;
  const next = t ? suggestedText(scn, t) : "";
  // the re-run is limited to the target promise (POST /api/runs with rules), so count those tests
  const affected = t ? scn.cases.filter((c) => (c.checks ?? []).some((ch) => ch.rule === t.rule.id)) : [];

  const suggest = () => {
    setState("thinking");
    window.setTimeout(() => setState("ready"), 1200);
  };
  const accept = async () => {
    if (!t || !detail.data) return;
    setState("busy");
    setErr(null);
    try {
      const saved = await savePrompt(name, { ...scn.sections, [t.section]: next }, `Fix for ${t.rule.id} (suggested edit)`);
      reloadScenarios();
      const { id } = await startRun({ kind: "eval", scenario: name, k: 3, cases: null, judge: true, rules: [t.rule.id], prompt_version: saved.version.n });
      reloadRuns();
      nav(evalEntry ? `${runHref(id)}/vs/${encodeURIComponent(evalEntry.id)}` : runHref(id));
    } catch (e) {
      setErr((e as Error).message);
      setState("ready");
    }
  };
  const editFirst = () => {
    if (!t) return;
    try {
      sessionStorage.setItem(SUGGEST_KEY, JSON.stringify({ section: t.section, text: next }));
    } catch {
      /* private mode */
    }
    nav(`/scenarios/${encodeURIComponent(name)}/prompt?p=${encodeURIComponent(t.rule.id)}`);
  };

  return (
    <>
      <StepHead
        title="Fix the blamed part"
        chip="preview"
        help="Preview: the suggestion is written here in the browser, not by a model yet. Everything after it is real: Accept saves a new prompt version and re-runs only the tests for this promise, then compares with the last check. Agents can already do the same through the MCP tools (get_brief, save_prompt_version, run_check, compare_runs)."
      />
      {!t ? (
        <div className="emptybox">
          <p className="emptybox-h">Nothing to fix</p>
          <p className="quiet">No promise breaks in the latest check.</p>
        </div>
      ) : (
        <div className="loop">
          <section className="panelbox panelbox-pad loop-setup" aria-labelledby="fix-pick">
            <h2 id="fix-pick" className="box-h">
              1 · What to fix
            </h2>
            <ul className="targets">
              {targets.map((x, i) => (
                <li key={`${x.rule.id}-${x.section}`}>
                  <label>
                    <input
                      type="radio"
                      name="fix-target"
                      checked={x === t}
                      onChange={() => {
                        setPick(i);
                        setState("idle");
                      }}
                    />
                    <span className="rule-ref">{x.rule.id}</span>
                    <span className="targets-title">{x.rule.title}</span>
                    <span className="targets-part">in {partLabel(x.section)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="quiet small">{t.why}</p>
            {!mapEntry && (
              <p className="small">
                Draw the <Link to={`/scenarios/${encodeURIComponent(name)}/map`}>map</Link> first for a sharper target.
              </p>
            )}
            <h2 className="box-h">2 · Guard</h2>
            <ul className="guards">
              <li>✓ Edit only ‘{partLabel(t.section)}’</li>
              <li>✓ No other promise may get worse</li>
              <li>✓ Re-run {plural(affected.length || scn.cases.length, "test")} before you keep it</li>
            </ul>
            <button type="button" className="btn btn-ink" disabled={!canSuggest || state === "thinking" || state === "busy"} onClick={suggest} title={canSuggest ? undefined : "Coming soon"}>
              {state === "thinking" ? "Writing an edit…" : state === "ready" ? "Suggest another" : "Suggest an edit (preview)"}
            </button>
            {!canSuggest && <p className="quiet small">Needs a local, editable (simulated) project.</p>}
          </section>
          <section className="panelbox panelbox-pad loop-preview" aria-labelledby="fix-prev">
            <h2 id="fix-prev" className="box-h">
              3 · Suggested edit {state !== "ready" && <Chip>example</Chip>}
              <Help>{canSuggest ? "Review the edit. Accept saves it as a new prompt version and re-runs the affected tests; Edit opens it in the prompt so you can change it first; Reject throws it away." : "Made up to show what a fix will look like. Not a real suggestion."}</Help>
            </h2>
            {state === "thinking" ? (
              <div className="ghost-note ghost-tall" aria-label="Writing an edit" />
            ) : (
              <div className="diffbox">
                <p className="diffbox-h">
                  <span className="doc-hash">##</span> {partLabel(t.section)}
                </p>
                <DiffText a={scn.sections[t.section] ?? ""} b={next} />
              </div>
            )}
            <h2 className="box-h">4 · What the re-run must show</h2>
            <Proof scn={scn} t={t} per={per} />
            {err && <p className="form-error">{err}</p>}
            <div className="form-actions">
              <button type="button" className="btn btn-ink" disabled={state !== "ready"} onClick={accept}>
                {state === "busy" ? "Saving…" : `Accept and re-run ${plural(affected.length || scn.cases.length, "test")}`}
              </button>
              <button type="button" className="btn btn-line" disabled={state !== "ready"} onClick={editFirst}>
                Edit first
              </button>
              <button type="button" className="btn btn-line" disabled={state !== "ready"} onClick={() => setState("idle")}>
                Reject
              </button>
            </div>
          </section>
        </div>
      )}
      <Flow active="fix" evalId={evalEntry?.id} />
    </>
  );
}

/** What the re-run will be judged on: the target must go down, nothing else may go up. Real numbers from the latest check. */
function Proof({ scn, t, per }: { scn: Scenario; t: Target; per: Record<string, { checked: number; violated: number; rate: number }> }) {
  return (
    <table className="proof">
      <thead>
        <tr>
          <th>Promise</th>
          <th className="num">Broke now</th>
          <th>After the re-run</th>
        </tr>
      </thead>
      <tbody>
        {scn.rules.map((r) => {
          const now = per[r.id]?.rate ?? null;
          return (
            <tr key={r.id} className={r.id === t.rule.id ? "is-target" : ""}>
              <td>
                <span className="rule-ref">{r.id}</span> {r.title}
              </td>
              <td className="num">{now === null ? "–" : pct(now)}</td>
              <td className="small">{r.id === t.rule.id ? <span className="t-holds">should go down</span> : <span className="quiet">must not go up</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
