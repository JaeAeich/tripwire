// Project pages built on the run history: Overview (promises × checks), Prompt (document, versions, edit, re-run),
// one promise across runs, one test across runs, and the share / CI panel.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { compareRuns as compareApi, getScenario, MOCK, startRun } from "../lib/api";
import { bestSentence, placeRules, sentences } from "../lib/anchor";
import { claimOf } from "../lib/attribution";
import { useAppData, useScenario } from "../lib/context";
import { wordDiff } from "../lib/diff";
import { ago, pct, plural, stamp, usd } from "../lib/format";
import { caseTrials, perRuleOf, perTrialCost, ruleSeries, useHistory, versionOfRun, type Change, type Version } from "../lib/history";
import { useAsync, useDocumentTitle, useRun } from "../lib/hooks";
import { useRuns } from "../lib/projects";
import { runHref, scenarioHref, trialHref } from "../lib/routes";
import type { AttackSummary, AttributionSummary, Case, CompareChange, CompareResult, Rule, RuleVerdict, Run, Scenario } from "../lib/types";
import { readRule, shortSentence } from "../lib/words";
import { ErrorNote, Loading } from "../components/bits";
import { Chip, type ChipTone } from "../components/Chip";
import { Drawer, HotProvider, Note, partLabel, PromptDoc, type Mark } from "../components/Doc";
import { EvidencePanel } from "../components/Evidence";
import { gather } from "../lib/evidence";
import { ProjectFrame } from "../components/ProjectFrame";
import { useEditing, type Editing } from "../lib/edit";
import { asDraftCase, newCaseFor } from "../lib/draft";
import { AddPromise, deletePromiseWith, DrafterNotes, notesLabel, useDeletePromise, usePromiseFields } from "../components/PromiseEdit";
import { AddPart, PartMenu, PartName } from "../components/PartEdit";
import { KindPick, TestBody, TestTitle, testActionsWith } from "../components/TestEditor";
import { RunBar } from "../components/LivePanel";
import { IntervalBar, KindBadge, VerdictChip } from "../components/promise";
import { Help, StatStrip, VerdictBar, verdictCounts } from "../components/Stats";
import { claimVerb } from "./AttributionRun";

export const promiseHref = (name: string, id: string) => `${scenarioHref(name)}/promises/${encodeURIComponent(id)}`;
export const testHref = (name: string, id: string) => `${scenarioHref(name)}/tests/${encodeURIComponent(id)}`;
export const compareRunsHref = (after: string, before: string) => `${runHref(after)}/vs/${encodeURIComponent(before)}`;

const shortDate = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const shortTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export const CHANGE_WORDS: Record<Change, { label: string; tone: ChipTone }> = {
  fixed: { label: "fixed", tone: "holds" },
  better: { label: "better", tone: "holds" },
  regressed: { label: "regressed", tone: "breaks" },
  worse: { label: "worse", tone: "flaky" },
  same: { label: "same", tone: "neutral" },
  new: { label: "new", tone: "neutral" },
  gone: { label: "not run", tone: "skip" },
};

/** A verdict as a fixed-size dot (the cells of the history grid). */
export function VerdictDot({ v, title }: { v: RuleVerdict | null; title?: string }) {
  return <span className={`vdot vdot-${v ?? "none"}`} title={title} />;
}

// ---------- Overview ----------

export function ProjectOverview() {
  const { name = "" } = useParams();
  useDocumentTitle(name);
  return (
    <ProjectFrame name={name} tab="overview">
      <Overview name={name} />
    </ProjectFrame>
  );
}

function Overview({ name }: { name: string }) {
  const scn = useScenario(name);
  const detail = useAsync(() => getScenario(name), [name]);
  const h = useHistory(name, scn?.sections);
  const lastId = h.evals[h.evals.length - 1]?.id;
  const prevId = h.evals[h.evals.length - 2]?.id;
  // the server's paired comparison: fixed / regressed only when the interval says so
  const cmp = useAsync(() => (lastId && prevId ? compareApi(prevId, lastId) : Promise.resolve(null)), [lastId, prevId]);
  if (!scn) return <Loading what="project" />;
  const latest = h.evals[h.evals.length - 1];
  const prev = h.evals[h.evals.length - 2];
  const ids = scn.rules.map((r) => r.id);
  const per = perRuleOf(latest);
  const c = verdictCounts(per, ids);
  const s = latest?.summary;
  const rowOf = (id: string) => cmp.data?.per_rule[id];
  const cc = { fixed: cmp.data?.fixed.length ?? 0, regressed: cmp.data?.regressed.length ?? 0 };
  const cols = h.evals.slice(-8);
  const spent = h.entries.reduce((x, r) => x + (r.headline?.cost_usd ?? 0), 0);
  const ORDER: Record<RuleVerdict, number> = { breaks: 0, flaky: 1, too_few: 2, holds: 3 };
  const attention = scn.rules
    .map((r) => ({ r, st: per[r.id], v: per[r.id] ? readRule(per[r.id]).verdict : ("too_few" as RuleVerdict), ch: rowOf(r.id) }))
    .filter((x) => x.v !== "holds")
    .sort((a, b) => ORDER[a.v] - ORDER[b.v] || a.r.id.localeCompare(b.r.id, undefined, { numeric: true }));

  if (!h.evals.length)
    return h.loading ? (
      <Loading what="history" />
    ) : (
      <div className="emptybox">
        <p className="emptybox-h">Not checked yet</p>
        <p className="quiet">
          {plural(scn.rules.length, "promise")} and {plural(scn.cases.length, "test")} are ready. Run a check to see which promises hold.
        </p>
      </div>
    );

  // one next step per promise: read the failure if there is one, otherwise get more evidence
  const next = (id: string, v: RuleVerdict) =>
    v === "too_few" && !(per[id]?.violated > 0) ? (
      detail.data?.editable ? (
        <Link to={promiseHref(name, id)} className="btn btn-line">
          Add tests
        </Link>
      ) : (
        <Link to={`${runHref(latest.id)}?p=${encodeURIComponent(id)}`} className="btn btn-line">
          Run more tries
        </Link>
      )
    ) : (
      <Link to={`${runHref(latest.id)}?p=${encodeURIComponent(id)}`} className="btn btn-line">
        See where it broke
      </Link>
    );

  return (
    <>
      <section className="block block-first" aria-labelledby="att-h">
        <h2 id="att-h" className="block-h">
          {attention.length ? "Needs attention" : "All clear"}
          {attention.length > 0 && <span className="block-sub">{attention.length}</span>}
          <span className="block-link quiet small">last check {ago(latest.created)}</span>
        </h2>
        {attention.length ? (
          <ol className="attention panelbox">
            {attention.map(({ r, st, v, ch }) => (
              <li key={r.id} className="att-row">
                <span className="att-chip">
                  <VerdictChip verdict={v} />
                </span>
                <Link to={promiseHref(name, r.id)} className="att-main">
                  <span className="att-title">
                    <span className="rule-ref">{r.id}</span> {r.title}
                    {ch?.change === "regressed" && <Chip tone="breaks">regressed</Chip>}
                  </span>
                  <span className="att-why">{st ? shortSentence(readRule(st).sentence) : "No conversation checked it"}</span>
                </Link>
                <span className="att-next">{next(r.id, v)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="calm panelbox">
            <p>
              All {plural(scn.rules.length, "promise")} held in the last check.
            </p>
            <Link to={`${scenarioHref(name)}/attack`} className="btn btn-line">
              Attack them
            </Link>
          </div>
        )}
      </section>

      <section className="block" aria-labelledby="grid-h">
        <h2 id="grid-h" className="block-h">
          Promises across checks
          <Help>One row per promise, one column per check, newest on the right. Click a dot to open that promise in that check, or a promise for its whole history.</Help>
          <span className="block-legend">
            <VerdictDot v="holds" /> holds <VerdictDot v="flaky" /> flaky <VerdictDot v="breaks" /> breaks <VerdictDot v="too_few" /> not sure
          </span>
        </h2>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th className="grid-promise">Promise</th>
                {cols.map((r) => {
                  const v = versionOfRun(h.versions, r);
                  return (
                    <th key={r.id} className="grid-col">
                      <Link to={runHref(r.id)} className="grid-colhead" title={stamp(r.created)}>
                        <span>{shortDate(r.created)}</span>
                        <span className="grid-ver">{v?.label ?? ""}</span>
                      </Link>
                    </th>
                  );
                })}
                <th className="grid-change">vs previous</th>
              </tr>
            </thead>
            <tbody>
              {scn.rules.map((r) => {
                const ch = rowOf(r.id);
                return (
                  <tr key={r.id}>
                    <td className="grid-promise">
                      <Link to={promiseHref(name, r.id)} className="grid-rule">
                        <span className="rule-ref">{r.id}</span>
                        <span className="grid-rule-title">{r.title}</span>
                      </Link>
                    </td>
                    {cols.map((run) => {
                      const st = perRuleOf(run)[r.id];
                      const rd = st ? readRule(st) : null;
                      return (
                        <td key={run.id} className="grid-col">
                          <Link to={`${runHref(run.id)}?p=${encodeURIComponent(r.id)}`} className="grid-cell" aria-label={`${r.id} on ${stamp(run.created)}: ${rd ? rd.verdict : "not checked"}`}>
                            <VerdictDot v={rd?.verdict ?? null} title={rd ? `${pct(st!.rate)} broken (${st!.violated}/${st!.checked})` : "not checked"} />
                          </Link>
                        </td>
                      );
                    })}
                    <td className="grid-change">
                      {ch && prev && (ch.change !== "same" || ch.leaning) ? <ChangeChip row={ch} /> : null}
                    </td>
                  </tr>
                );
              })}
              <tr className="grid-foot">
                <td className="grid-promise quiet">Pass rate</td>
                {cols.map((r) => (
                  <td key={r.id} className="grid-col num">
                    {pct(r.summary.pass_at_1)}
                  </td>
                ))}
                <td className="grid-change">
                  {prev && (
                    <Link to={compareRunsHref(latest.id, prev.id)} className="small">
                      compare
                    </Link>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="block" aria-labelledby="sum-h">
        <h2 id="sum-h" className="block-h">
          Last check
        </h2>
        <div className="summary-row panelbox">
          <div className="sum-cell sum-wide">
            <VerdictBar c={c} />
            <span className="sum-counts">
              <span>
                <b>{c.holds}</b> hold
              </span>
              <span className={c.breaks ? "t-breaks" : ""}>
                <b>{c.breaks}</b> break
              </span>
              <span className={c.flaky ? "t-flaky" : ""}>
                <b>{c.flaky}</b> flaky
              </span>
              <span>
                <b>{c.too_few}</b> not sure
              </span>
            </span>
          </div>
          <div className="sum-cell">
            <span className="sum-label">
              Pass rate <Help>Share of conversations where no promise broke, on a typical try, with its likely range.</Help>
            </span>
            <span className="sum-value">
              {pct(s?.pass_at_1)} <span className="quiet small">{s?.pass_at_1_ci ? `${pct(s.pass_at_1_ci[0])}–${pct(s.pass_at_1_ci[1])}` : ""}</span>
            </span>
          </div>
          <div className="sum-cell">
            <span className="sum-label">Since previous</span>
            <span className="sum-value">
              {prev ? (
                <>
                  <span className={cc.fixed ? "t-holds" : ""}>+{cc.fixed}</span> / <span className={cc.regressed ? "t-breaks" : ""}>−{cc.regressed}</span>
                </>
              ) : (
                "–"
              )}
            </span>
          </div>
          <div className="sum-cell">
            <span className="sum-label">Cost</span>
            <span className="sum-value">
              {usd(s?.cost_usd)} <span className="quiet small">{usd(spent)} total</span>
            </span>
          </div>
        </div>
        <p className="details-line">
          <span>{plural(Object.keys(scn.sections).length, "prompt part")}</span>
          <span>{plural(scn.cases.length, "test")}</span>
          <span>{plural(h.versions.length, "prompt version")}</span>
          <span>{plural(h.entries.length, "run")}</span>
          <span>models {latest.config.models ? `${latest.config.models.agent} / ${latest.config.models.user} / ${latest.config.models.judge}` : "–"}</span>
        </p>
      </section>
    </>
  );
}

// ---------- Prompt: the document, versions, edit and re-run ----------

export function ProjectPrompt() {
  const { name = "" } = useParams();
  useDocumentTitle(`${name} prompt`);
  return (
    <ProjectFrame name={name} tab="prompt">
      <HotProvider>
        <PromptTab name={name} />
      </HotProvider>
    </ProjectFrame>
  );
}

function PromptTab({ name }: { name: string }) {
  const scn = useScenario(name);
  const editing = useEditing();
  const { reloadRuns } = useAppData();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const h = useHistory(name, scn?.sections);
  const maps = useProjectRunsOfKind(name, "attribute");
  const attacks = useProjectRunsOfKind(name, "attack");
  const [pick, setPick] = useState<string | null>(null);
  const [diff, setDiff] = useState(false);
  const [edit, setEdit] = useState<{ section: string; text: string } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sel = params.get("p");
  const select = useCallback((id: string | null) => setParams(id ? { p: id } : {}, { replace: true }), [setParams]);
  // an edit suggested on the Fix tab ("Edit first") opens here, in place, ready to change
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("tw-suggest");
      if (!raw) return;
      sessionStorage.removeItem("tw-suggest");
      const s = JSON.parse(raw) as { section: string; text: string };
      if (s.section) setEdit(s);
    } catch {
      /* ignore */
    }
  }, []);
  // ?edit=Part (mock only) opens a part for editing on load, for screenshots
  useEffect(() => {
    const part = params.get("edit");
    if (MOCK && part && scn?.sections[part] !== undefined && !edit) setEdit({ section: part, text: scn.sections[part] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scn?.name]);
  if (!scn) return <Loading what="prompt" />;
  const versions = h.versions;
  const current = versions.find((v) => v.key === JSON.stringify(Object.entries(scn.sections))) ?? versions[versions.length - 1];
  const shown: Version | undefined = versions.find((v) => v.label === pick) ?? current;
  const idx = shown ? versions.indexOf(shown) : -1;
  const prevV = idx > 0 ? versions[idx - 1] : undefined;
  const latestOfShown = shown ? h.evals.filter((r) => shown.runs.includes(r.id)).pop() : undefined;
  const run = latestOfShown ?? h.evals[h.evals.length - 1];
  const sections = shown?.sections ?? scn.sections;
  const editable = editing.editable;
  const isCurrent = !shown || shown === current;
  const mapRun = maps.find((m) => m.config.base_run === run?.id) ?? maps[0] ?? null;
  const ev = sel ? gather({ ...scn, sections }, sel, run, mapRun, attacks) : null;
  const place = placeRules(sections, scn.rules);
  const rulesOf = (section: string) => scn.rules.filter((r) => place[r.id] === section).map((r) => r.id);
  const affected = (section: string) => {
    const rules = rulesOf(section);
    return scn.cases.filter((c) => (c.checks ?? []).some((ch) => rules.includes(ch.rule)));
  };
  // same basis as the server's estimate: median cost per conversation of recent checks
  const perTrial = perTrialCost(h.evals);
  const rerunCost = (section: string) => (affected(section).length || scn.cases.length) * k * perTrial;
  const k = run?.config.k ?? 3;

  const save = async (andRun: boolean) => {
    if (!edit || !editable) return;
    setBusy(andRun ? "run" : "save");
    setErr(null);
    try {
      const saved = await editing.savePrompt((cur) => ({ ...cur, [edit.section]: edit.text }), { note: note.trim() || `Edited ${partLabel(edit.section)}` });
      const rules = rulesOf(edit.section);
      setEdit(null);
      setNote("");
      setPick(null);
      if (andRun) {
        const { id } = await startRun({
          kind: "eval",
          scenario: name,
          k,
          cases: null,
          judge: true,
          rules: rules.length ? rules : undefined,
          prompt_version: saved.version ?? undefined,
        });
        reloadRuns();
        nav(run ? compareRunsHref(id, run.id) : runHref(id));
      } else setBusy(null);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };

  const structure = editable && isCurrent && !edit && !diff;
  const startEdit = (section: string) => {
    setDiff(false);
    setEdit({ section, text: sections[section] ?? "" });
  };

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Prompt version">
          {versions.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={v === shown}
              className={v === shown ? "is-on" : ""}
              onClick={() => {
                setPick(v.label);
                setEdit(null);
              }}
              title={v.unrun ? "Saved, not checked yet" : `First checked ${stamp(v.first)} · ${plural(v.runs.length, "check")}`}
            >
              {v.label}
              {v.unrun ? " · not run" : ""}
            </button>
          ))}
        </div>
        <p className="quiet small toolbar-mid">
          {shown?.unrun ? "saved, not checked yet" : shown ? `${plural(shown.runs.length, "check")} · from ${shortDate(shown.first)}` : ""}
          {isCurrent ? " · current" : ""}
        </p>
        <div className="toolbar-actions">
          {prevV && !edit && (
            <button type="button" className="btn btn-line" aria-pressed={diff} onClick={() => setDiff(!diff)}>
              {diff ? "Hide changes" : `Changes since ${prevV.label}`}
            </button>
          )}
        </div>
      </div>
      {err && <p className="form-error">{err}</p>}

      <div className="doc-frame">
        <div className="doc-frame-head">
          <span className="lg lg-breaks">breaks</span>
          <span className="lg lg-flaky">flaky</span>
          <span className="lg lg-too_few">not sure</span>
          <Help>{`Each underlined line is where a promise comes from; its label says which. Click a line, a label or a note to see the evidence beside the prompt: what broke, in which conversation, and what the map says.${editable ? " Hover a part's heading to edit it." : ""}`}</Help>
          {run && <span className="doc-frame-map quiet">verdicts from the check of {shortDate(run.created)}</span>}
        </div>
        {diff && prevV ? (
          <DiffDoc before={prevV.sections} after={sections} />
        ) : (
          <VerdictDoc
            scn={scn}
            sections={sections}
            run={run}
            selected={sel}
            onPick={(id) => select(id)}
            renderHead={structure ? (section) => <PartName name={section} /> : undefined}
            headAction={
              structure
                ? (section) => (
                    <>
                      <button type="button" className="link-btn doc-edit-btn" onClick={() => startEdit(section)}>
                        Edit text
                      </button>
                      <PartMenu name={section} />
                    </>
                  )
                : undefined
            }
            marginAdd={structure ? (section) => <AddPromise section={section} label="+ Add a promise" /> : undefined}
            after={structure ? <AddPart /> : undefined}
            notes={isCurrent && (editing.draft?.notes.length ?? 0) > 0 ? editing.draft!.notes.length : 0}
            renderText={
              edit
                ? (section) =>
                    section === edit.section ? (
                      <div className="doc-editing">
                        <textarea className="doc-edit" value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} aria-label={`Edit ${partLabel(section)}`} autoFocus />
                        <input
                          className="doc-edit-note"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder={`What changed? (saved with the new version, e.g. “Refunds: no exceptions”)`}
                          aria-label="Version note"
                        />
                        <div className="doc-edit-bar">
                          <button type="button" className="btn btn-line" onClick={() => setEdit(null)} disabled={busy !== null}>
                            Cancel
                          </button>
                          <button type="button" className="btn btn-line" onClick={() => save(false)} disabled={busy !== null || edit.text === sections[section]}>
                            {busy === "save" ? "Saving…" : "Save as new version"}
                          </button>
                          <button type="button" className="btn btn-ink" onClick={() => save(true)} disabled={busy !== null || edit.text === sections[section]}>
                            {busy === "run"
                              ? "Starting…"
                              : `Save and re-run ${plural(affected(section).length || scn.cases.length, "test")} · ~${usd(rerunCost(section))}`}
                          </button>
                          <Help>{`Saves v${(versions[versions.length - 1]?.n ?? versions.length) + 1}, then re-runs only the tests that check ${rulesOf(section).join(", ") || "this part's promises"} (${(affected(section).length || scn.cases.length) * k} conversations at ~${usd(perTrial)} each, the median of recent checks) and compares each promise with the previous check.`}</Help>
                        </div>
                      </div>
                    ) : null
                : undefined
            }
          />
        )}
      </div>

      <Drawer open={!!ev} onClose={() => select(null)} label="Evidence" docked>
        {ev && (
          <EvidencePanel
            e={ev}
            project={name}
            head={editable ? <PromiseHead id={ev.rule.id} onDeleted={() => select(null)} /> : undefined}
            actions={
              editable && isCurrent && ev.section ? (
                <button type="button" className="btn btn-ink" onClick={() => startEdit(ev.section!)}>
                  Edit the text of ‘{partLabel(ev.section)}’
                </button>
              ) : undefined
            }
          />
        )}
      </Drawer>
    </>
  );
}

/** The prompt with each promise's verdict in the margin and a label on its line. Clicking either picks the promise. */
function VerdictDoc({
  scn,
  sections,
  run,
  selected,
  onPick,
  headAction,
  renderText,
  renderHead,
  marginAdd,
  after,
  notes = 0,
}: {
  scn: Scenario;
  sections: Record<string, string>;
  run?: Run;
  selected?: string | null;
  onPick: (id: string) => void;
  headAction?: (section: string) => ReactNode;
  renderText?: (section: string) => ReactNode;
  renderHead?: (section: string) => ReactNode;
  /** e.g. "+ Add a promise" at the foot of a part's margin */
  marginAdd?: (section: string) => ReactNode;
  after?: ReactNode;
  /** drafter notes still open: shown above the first part */
  notes?: number;
}) {
  const per = perRuleOf(run);
  const place = placeRules(sections, scn.rules);
  const verdict = (id: string): RuleVerdict | null => (per[id] ? readRule(per[id]).verdict : null);
  const SEV: Record<string, number> = { breaks: 0, flaky: 1, too_few: 2, holds: 3, none: 4 };
  // worst first within a part, so what needs attention is at the top of the margin
  const at = (n: string | null) =>
    scn.rules.filter((r) => (place[r.id] ?? null) === n).sort((a, b) => SEV[verdict(a.id) ?? "none"] - SEV[verdict(b.id) ?? "none"]);
  const note = (r: Rule, section: string | null) => {
    const v = verdict(r.id);
    const st = per[r.id];
    const reading = st ? readRule(st) : null;
    return (
      <Note key={r.id} hotKey={r.id} section={section} tone={v ?? undefined} onClick={() => onPick(r.id)} selected={selected === r.id} label={`${r.id} ${r.title}: open the evidence`}>
        <span className="note-top">
          {v ? <VerdictChip verdict={v} /> : <Chip>not run</Chip>}
          <span className="rule-ref">{r.id}</span>
        </span>
        <span className="note-title">{r.title}</span>
        <span className="note-text">{reading ? `${shortSentence(reading.sentence)}.` : "Not checked yet."}</span>
        {reading && st && v !== "holds" && <IntervalBar rate={st.rate} lo={reading.lo} hi={reading.hi} verdict={v ?? "too_few"} compact />}
      </Note>
    );
  };
  const marks = (n: string): Mark[] =>
    at(n).flatMap((r) => {
      const i = bestSentence(sections[n] ?? "", r);
      return i === null ? [] : [{ key: r.id, sentence: i, tone: verdict(r.id) ?? "plain" }];
    });
  const WORD: Partial<Record<string, string>> = { breaks: "breaks", flaky: "flaky", too_few: "not sure" };
  return (
    <article className="sheet">
      <PromptDoc
        sections={sections}
        marks={marks}
        margin={(n) => (
          <>
            {at(n).map((r) => note(r, n))}
            {marginAdd?.(n)}
          </>
        )}
        lead={
          at(null).length || notes
            ? { label: notes ? notesLabel(notes) : "Whole prompt", body: notes ? <DrafterNotes /> : undefined, notes: at(null).map((r) => note(r, null)) }
            : undefined
        }
        renderHead={renderHead}
        after={after}
        tagFor={(key, tone) => (WORD[tone] ? `${key} · ${WORD[tone]}` : null)}
        onPick={(key) => onPick(key)}
        headAction={headAction}
        renderText={renderText ? (n) => renderText(n) ?? undefined : undefined}
      />
    </article>
  );
}

function DiffDoc({ before, after }: { before: Record<string, string>; after: Record<string, string> }) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return (
    <article className="sheet">
      <PromptDoc
        sections={Object.fromEntries(names.map((n) => [n, ""]))}
        margin={(n) => (
          <p className="margin-quiet">
            {before[n] === undefined ? <Chip tone="holds">new part</Chip> : after[n] === undefined ? <Chip tone="breaks">removed</Chip> : before[n] === after[n] ? "unchanged" : <Chip tone="flaky">changed</Chip>}
          </p>
        )}
        dim={(n) => before[n] === after[n]}
        renderText={(n) => <DiffText a={before[n] ?? ""} b={after[n] ?? ""} />}
      />
    </article>
  );
}

export function DiffText({ a, b }: { a: string; b: string }) {
  return (
    <p className="doc-p diff-p">
      {wordDiff(a, b).map((p, i) => (p.op === "same" ? <span key={i}>{p.text}</span> : p.op === "del" ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>))}
    </p>
  );
}

// ---------- one promise ----------

/** Add a starter test for a promise; resolves to its id. */
async function addTestFor(e: Editing, ruleId: string): Promise<string | null> {
  let id: string | null = null;
  await e.update((d) => {
    const c = newCaseFor(d.rules.find((r) => r.id === ruleId), d.cases);
    id = c.id;
    return { ...d, cases: [...d.cases, c] };
  });
  return id;
}

/** A promise's name, words and part, edited in place. */
function PromiseHead({ id, fallback, big, onDeleted }: { id: string; fallback?: Rule; big?: boolean; onDeleted?: () => void }) {
  const { draft } = useEditing();
  const rule = draft?.rules.find((r) => r.id === id) ?? fallback;
  if (!rule) return null;
  return <PromiseHeadFor rule={rule} big={big} onDeleted={onDeleted} />;
}

function PromiseHeadFor({ rule, big, onDeleted }: { rule: Rule; big?: boolean; onDeleted?: () => void }) {
  const f = usePromiseFields(rule);
  const del = useDeletePromise();
  return (
    <>
      <h2 className={big ? "entity-title" : "panel-title"}>{f.title}</h2>
      <blockquote className="rule-quote">{f.text}</blockquote>
      {f.editable && (
        <p className="promise-meta small">
          <span className="quiet">From</span> {f.part}
          {onDeleted && (
            <button type="button" className="link-btn quiet-btn promise-del" onClick={async () => (await del(rule.id)) && onDeleted()}>
              Delete promise…
            </button>
          )}
        </p>
      )}
    </>
  );
}

function AddTestLink({ rule }: { rule: string }) {
  const e = useEditing();
  const nav = useNavigate();
  const { name = "" } = useParams();
  if (!e.editable) return null;
  return (
    <button type="button" className="link-btn block-link" onClick={() => addTestFor(e, rule).then((id) => id && nav(testHref(name, id)))}>
      Add a test for {rule}
    </button>
  );
}

export function PromisePage() {
  const nav = useNavigate();
  const { name = "", rule = "" } = useParams();
  useDocumentTitle(`${rule} · ${name}`);
  return (
    <ProjectFrame
      name={name}
      tab="overview"
      menu={(e) =>
        e.editable
          ? [
              { label: `Add a test for ${rule}`, onClick: () => addTestFor(e, rule).then((id) => id && nav(testHref(name, id))) },
              { label: "Delete promise…", onClick: () => deletePromiseWith(e)(rule).then((ok) => ok && nav(scenarioHref(name))) },
            ]
          : []
      }
    >
      <HotProvider pinned={rule}>
        <PromiseView name={name} id={rule} />
      </HotProvider>
    </ProjectFrame>
  );
}

function useProjectRunsOfKind(name: string, kind: "attribute" | "attack") {
  const { runs } = useAppData();
  const entries = (runs ?? []).filter((r) => r.scenario === name && r.kind === kind && r.status !== "running");
  const details = useRuns(entries);
  return entries.map((e) => details[e.id]).filter((r): r is Run => !!r);
}

function PromiseView({ name, id }: { name: string; id: string }) {
  const scn = useScenario(name);
  const h = useHistory(name, scn?.sections);
  const maps = useProjectRunsOfKind(name, "attribute");
  const attacks = useProjectRunsOfKind(name, "attack");
  if (!scn) return <Loading what="promise" />;
  const rule = scn.rules.find((r) => r.id === id);
  if (!rule) return <ErrorNote error={new Error(`no promise ${id} in ${name}`)} what="promise" />;
  const series = ruleSeries(h.evals, id);
  const last = [...series].reverse().find((p) => p.reading);
  const place = placeRules(scn.sections, scn.rules)[id];
  const sIdx = place ? bestSentence(scn.sections[place], rule) : null;
  const tests = scn.cases.filter((c) => (c.checks ?? []).some((ch) => ch.rule === id));
  const cols = h.evals.slice(-8);
  const claims = maps.flatMap((m) => ((m.summary as Partial<AttributionSummary>).matrix ?? []).filter((c) => c.rule === id).map((c) => ({ run: m, claim: claimOf(c) }))).filter((x) => x.claim);
  const atk = attacks.filter((a) => (a.summary as unknown as Partial<AttackSummary>).per_rule?.[id]);

  return (
    <>
      <div className="entity-head">
        <p className="entity-kicker">
          {last?.reading ? <VerdictChip verdict={last.reading.verdict} /> : <Chip>not run</Chip>}
          <span className="rule-ref">{id}</span>
          <span className="quiet small">promise</span>
        </p>
        <PromiseHead id={id} fallback={rule} big />
      </div>

      <StatStrip
        items={[
          {
            label: "Latest",
            value: last?.stat ? pct(last.stat.rate) : "–",
            sub: last?.reading ? `broken · likely ${pct(last.reading.lo)}–${pct(last.reading.hi)}` : "not checked",
            tone: last?.reading ? (last.reading.verdict as "holds" | "breaks" | "flaky" | "too_few") : undefined,
          },
          { label: "Checks", value: series.filter((p) => p.stat).length, sub: `of ${h.evals.length}` },
          { label: "Tests", value: tests.length, sub: `${tests.filter((t) => t.kind === "trap").length} traps · ${tests.filter((t) => t.kind === "lookalike").length} look-alikes` },
          { label: "Map findings", value: claims.length, sub: claims[0] ? `${claimVerb(claims[0].claim!)}: ${claims[0].claim!.cell.section}` : "none" },
          {
            label: "Attacks",
            value: atk.reduce((x, a) => x + ((a.summary as unknown as AttackSummary).per_rule[id]?.attacks ?? 0), 0),
            sub: `${atk.reduce((x, a) => x + ((a.summary as unknown as AttackSummary).per_rule[id]?.broken_by ?? 0), 0)} broke it`,
          },
        ]}
      />

      <div className="pair-blocks">
        <section className="block" aria-labelledby="src-h">
          <h2 id="src-h" className="block-h">
            Where it comes from
          </h2>
          {place ? (
            <div className="mini-sheet">
              <p className="doc-h">
                <span className="doc-hash">##</span>
                {partLabel(place)}
              </p>
              <p className="doc-p">
                {sentences(scn.sections[place]).map((s, i) =>
                  i === sIdx ? (
                    <mark key={i} className={`mk mk-${last?.reading?.verdict ?? "plain"} is-lit`}>
                      {s}
                    </mark>
                  ) : (
                    <span key={i}>{s}</span>
                  ),
                )}
              </p>
            </div>
          ) : (
            <p className="quiet">Not tied to one part of the prompt.</p>
          )}
        </section>
        <section className="block" aria-labelledby="every-h">
          <h2 id="every-h" className="block-h">
            Every check
          </h2>
          <ul className="panelbox series">
            {[...series].reverse().map((p) => {
              const v = versionOfRun(h.versions, p.run);
              return (
                <li key={p.run.id}>
                  <Link to={`${runHref(p.run.id)}?p=${encodeURIComponent(id)}`} className="series-row">
                    <span className="series-when">
                      {shortDate(p.run.created)} <span className="quiet">{shortTime(p.run.created)}</span>
                    </span>
                    <span className="series-ver quiet">{v?.label}</span>
                    <span className="series-chip">{p.reading ? <VerdictChip verdict={p.reading.verdict} /> : <Chip tone="skip">not checked</Chip>}</span>
                    <span className="series-bar">
                      {p.stat && p.reading && <IntervalBar rate={p.stat.rate} lo={p.reading.lo} hi={p.reading.hi} verdict={p.reading.verdict} compact />}
                    </span>
                    <span className="series-n num">{p.stat ? `${p.stat.violated}/${p.stat.checked}` : ""}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <section className="block" aria-labelledby="tests-h">
        <h2 id="tests-h" className="block-h">
          Its tests
          <span className="block-sub">{tests.length}</span>
          <Help>Each mark is one try of that test in that check, judged on this promise only. Red broke it, grey couldn't run.</Help>
          <AddTestLink rule={id} />
        </h2>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th className="grid-promise">Test</th>
                {cols.map((r) => (
                  <th key={r.id} className="grid-col grid-col-wide">
                    <span className="grid-colhead">
                      <span>{shortDate(r.created)}</span>
                      <span className="grid-ver">{versionOfRun(h.versions, r)?.label}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tests.map((c) => (
                <tr key={c.id}>
                  <td className="grid-promise">
                    <Link to={testHref(name, c.id)} className="grid-rule">
                      <KindBadge kind={c.kind} />
                      <span className="grid-rule-title">{c.title}</span>
                    </Link>
                  </td>
                  {cols.map((run) => (
                    <td key={run.id} className="grid-col grid-col-wide">
                      <Tries run={run} caseId={c.id} rule={id} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(claims.length > 0 || atk.length > 0) && (
        <div className="pair-blocks">
          <section className="block" aria-labelledby="map-h">
            <h2 id="map-h" className="block-h">
              Map findings
            </h2>
            {claims.length ? (
              <ul className="panelbox findings">
                {claims.map(({ run, claim }) => (
                  <li key={`${run.id}-${claim!.cell.section}`}>
                    <Link to={runHref(run.id)} className="finding-row">
                      <Chip tone={claim!.effect === "holds" ? "holds" : "breaks"} dot>
                        {claimVerb(claim!)}
                      </Chip>
                      <span className="finding-part">{partLabel(claim!.cell.section)}</span>
                      <span className="quiet small num">
                        {pct(claim!.cell.ablated_rate)} without · {pct(claim!.cell.base_rate)} with
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="quiet">No part clearly changes this promise.</p>
            )}
          </section>
          <section className="block" aria-labelledby="atk-h">
            <h2 id="atk-h" className="block-h">
              Attacks against it
              <Link to={`${scenarioHref(name)}/attack`} className="block-link">
                New attack
              </Link>
            </h2>
            {atk.length ? (
              <ul className="panelbox findings">
                {atk.map((a) => {
                  const pr = (a.summary as unknown as AttackSummary).per_rule[id];
                  return (
                    <li key={a.id}>
                      <Link to={runHref(a.id)} className="finding-row">
                        <Chip tone={pr.broken_by ? "breaks" : "holds"} dot>
                          {pr.broken_by ? `broken by ${pr.broken_by}/${pr.attacks}` : `held ${pr.attacks}/${pr.attacks}`}
                        </Chip>
                        <span className="finding-part">{shortDate(a.created)}</span>
                        <span className="quiet small num">
                          {pr.broke}/{pr.tries} tries
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="quiet">Not attacked yet.</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function Tries({ run, caseId, rule }: { run: Run; caseId: string; rule?: string }) {
  const ts = caseTrials(run, caseId);
  if (!ts.length) return <span className="quiet small">–</span>;
  return (
    <span className="ticks">
      {ts.map((t) => {
        const vs = rule ? t.verdicts.filter((v) => v.rule === rule) : t.verdicts;
        const state = t.error ? "skip" : vs.some((v) => !v.passed && !v.error) ? "fail" : "pass";
        return <Link key={t.trial} to={trialHref(run.id, t)} className={`tk tk-${state}`} title={`try ${t.trial + 1}: ${state === "fail" ? "broke" : state === "skip" ? "couldn't run" : "kept"}`} />;
      })}
    </span>
  );
}

// ---------- one test ----------

export function TestPage() {
  const { name = "", test = "" } = useParams();
  useDocumentTitle(`test ${test} · ${name}`);
  const nav = useNavigate();
  return (
    <ProjectFrame
      name={name}
      tab="tests"
      menu={(e) => {
        const c = e.draft?.cases.find((x) => x.id === test);
        if (!e.editable || !c) return [];
        const act = testActionsWith(e);
        return [
          { label: "Duplicate test", onClick: () => act.duplicate(test) },
          { label: "Delete test…", onClick: () => act.remove(c).then((ok) => ok && nav(`${scenarioHref(name)}/tests`)) },
        ];
      }}
    >
      <TestView name={name} id={test} />
    </ProjectFrame>
  );
}

function TestView({ name, id }: { name: string; id: string }) {
  const scn = useScenario(name);
  const { draft } = useEditing();
  const h = useHistory(name, scn?.sections);
  if (!scn) return <Loading what="test" />;
  const c: Case | undefined = scn.cases.find((x) => x.id === id);
  if (!c) return <ErrorNote error={new Error(`no test ${id} in ${name}`)} what="test" />;
  const rules = Object.fromEntries(scn.rules.map((r) => [r.id, r]));
  const runs = [...h.evals].reverse();
  const ran = runs.flatMap((r) => caseTrials(r, id)).filter((t) => !t.error);
  const passed = ran.filter((t) => t.passed).length;
  const dc = draft?.cases.find((x) => x.id === id) ?? asDraftCase(c);
  const edited = (r: Run) => {
    const then = r.config.case_hashes?.[id];
    return !!then && !!c.hash && then !== c.hash;
  };
  return (
    <>
      <div className="entity-head">
        <p className="entity-kicker">
          <KindPick c={dc} />
          <span className="rule-ref">test {c.id}</span>
        </p>
        <h2 className="entity-title">
          <TestTitle c={dc} />
        </h2>
      </div>
      <StatStrip
        items={[
          { label: "Passed", value: ran.length ? `${passed}/${ran.length}` : "–", sub: "tries, all checks", tone: ran.length && passed < ran.length ? "breaks" : ran.length ? "holds" : undefined },
          { label: "Checks", value: runs.filter((r) => caseTrials(r, id).length).length },
          { label: "Promises it checks", value: [...new Set((c.checks ?? []).map((x) => x.rule))].length },
        ]}
      />
      <div className="pair-blocks">
        <section className="block" aria-labelledby="who-h">
          <h2 id="who-h" className="block-h">
            The test
          </h2>
          <div className="panelbox panelbox-pad">
            <TestBody c={dc} rules={draft?.rules ?? scn.rules} tools={draft?.tools ?? []} />
          </div>
        </section>
        <section className="block" aria-labelledby="runs-h">
          <h2 id="runs-h" className="block-h">
            Every check
            <Help>Each mark is one try. Click it to read that conversation.</Help>
          </h2>
          {!runs.length && <p className="panelbox panelbox-pad quiet">Not run yet.</p>}
          <ul className="panelbox series" hidden={!runs.length}>
            {runs.map((r) => {
              const ts = caseTrials(r, id);
              const broke = [...new Set(ts.flatMap((t) => t.verdicts.filter((v) => !v.passed && !v.error).map((v) => v.rule)))];
              return (
                <li key={r.id}>
                  <div className="series-row">
                    <span className="series-when">
                      <Link to={runHref(r.id)}>{shortDate(r.created)}</Link> <span className="quiet">{shortTime(r.created)}</span>
                    </span>
                    <span className="series-ver quiet">{versionOfRun(h.versions, r)?.label}</span>
                    <Tries run={r} caseId={id} />
                    <span className="series-broke">
                      {edited(r) && (
                        <Chip title="This test changed after this check ran: its results are for the old version">edited since</Chip>
                      )}
                      {broke.map((b) => (
                        <Link key={b} to={promiseHref(name, b)} title={rules[b]?.title}>
                          <Chip tone="breaks">broke {b}</Chip>
                        </Link>
                      ))}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}

// ---------- compare two checks ----------

const COMPARE_WORDS: Record<CompareChange, { label: string; tone: ChipTone }> = {
  fixed: { label: "fixed", tone: "holds" },
  regressed: { label: "regressed", tone: "breaks" },
  same: { label: "no clear change", tone: "neutral" },
  new: { label: "new", tone: "neutral" },
  not_rerun: { label: "not re-run", tone: "skip" },
};

export function RunCompare() {
  const { id = "", other = "" } = useParams();
  useDocumentTitle("compare");
  // the later run may still be running (a fresh re-run): keep both fresh, re-ask the server as trials land
  const x = useRun(id);
  const y = useRun(other);
  const [before, after] = x.data && y.data ? (y.data.created <= x.data.created ? [y.data, x.data] : [x.data, y.data]) : [undefined, undefined];
  const cmp = useAsync(
    () => (before && after ? compareApi(before.id, after.id) : Promise.resolve(null)),
    [before?.id, after?.id, after?.trials.length, after?.status],
  );
  if (x.error || y.error) return <div className="view"><ErrorNote error={(x.error ?? y.error)!} what="runs" /></div>;
  if (!before || !after) return <div className="view"><Loading what="comparison" /></div>;
  return (
    <ProjectFrame name={after.scenario} tab="runs" runId={after.id}>
      <Compare before={before} after={after} cmp={cmp.data ?? null} err={cmp.error} />
    </ProjectFrame>
  );
}

/** One chip for a change: fixed / regressed / new / not re-run, or "leaning better/worse" when the interval can't tell. */
export function ChangeChip({ row }: { row: { change: CompareChange; leaning?: "better" | "worse" | null; sentence?: string } }) {
  if (row.change === "same" && row.leaning)
    return (
      <Chip tone="neutral" title={row.sentence}>
        leaning {row.leaning} {row.leaning === "better" ? "↘" : "↗"}
      </Chip>
    );
  return (
    <Chip tone={COMPARE_WORDS[row.change].tone} title={row.sentence}>
      {COMPARE_WORDS[row.change].label}
    </Chip>
  );
}

function Compare({ before, after, cmp, err }: { before: Run; after: Run; cmp: CompareResult | null; err?: Error }) {
  const scn = useScenario(after.scenario);
  const nav = useNavigate();
  const h = useHistory(after.scenario, scn?.sections);
  const rules = Object.fromEntries((scn?.rules ?? []).map((r) => [r.id, r]));
  const parts = useMemo(() => {
    const A = before.config.prompt ?? {};
    const B = after.config.prompt ?? {};
    return [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((n) => A[n] !== B[n]).map((n) => ({ n, a: A[n], b: B[n] }));
  }, [before, after]);
  const va = before.config.prompt_version ?? versionOfRun(h.versions, before)?.n;
  const vb = after.config.prompt_version ?? versionOfRun(h.versions, after)?.n;
  const ma = before.config.models;
  const mb = after.config.models;
  const modelChanges = ma && mb ? (["agent", "user", "judge"] as const).filter((k) => ma[k] !== mb[k]) : [];
  const da = before.summary.pass_at_1 ?? 0;
  const db = after.summary.pass_at_1 ?? 0;
  const order: CompareChange[] = ["regressed", "fixed", "new", "same", "not_rerun"];
  const rows = cmp ? Object.entries(cmp.per_rule).sort((x, y) => order.indexOf(x[1].change) - order.indexOf(y[1].change) || x[0].localeCompare(y[0], undefined, { numeric: true })) : [];
  const better = cmp ? rows.filter(([, r]) => r.change === "same" && r.leaning === "better").length : 0;
  const worse = cmp ? rows.filter(([, r]) => r.change === "same" && r.leaning === "worse").length : 0;
  const limited = after.config.rules?.length ? after.config.rules : null;

  return (
    <>
      {after.status === "running" && <RunBar run={after} what="Re-running" />}
      <div className="runmeta">
        <div className="runmeta-main">
          <h2 className="runmeta-title">{cmp ? cmp.sentence[0].toUpperCase() + cmp.sentence.slice(1) : "Comparing…"}</h2>
          <p className="runmeta-facts">
            <span>
              <Link to={runHref(after.id)}>
                {after.config.label ? `“${after.config.label}”` : `${shortDate(after.created)} ${shortTime(after.created)}`}
              </Link>{" "}
              vs{" "}
              <Link to={runHref(before.id)}>
                {before.config.label ? `“${before.config.label}”` : `${shortDate(before.created)} ${shortTime(before.created)}`}
              </Link>
            </span>
            <span>{va && vb ? (va === vb ? `same prompt (v${vb})` : `prompt v${va} → v${vb}`) : ""}</span>
            {limited && <span>re-ran only the tests for {limited.join(", ")}</span>}
            <span>
              {before.config.k} → {after.config.k} tries per test
            </span>
          </p>
        </div>
        <label className="switcher">
          <span className="switcher-label">vs</span>
          <select value={before.id} onChange={(e) => nav(compareRunsHref(after.id, e.target.value))}>
            {h.evals
              .filter((r) => r.id !== after.id)
              .reverse()
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {stamp(r.created)}
                  {versionOfRun(h.versions, r) ? ` · ${versionOfRun(h.versions, r)!.label}` : ""}
                  {r.config.label ? ` · ${r.config.label}` : ""}
                </option>
              ))}
          </select>
        </label>
      </div>
      {err && <ErrorNote error={err} what="comparison" />}

      <div className="summary-row panelbox">
        <div className="sum-cell">
          <span className="sum-label">Fixed</span>
          <span className={`sum-value${cmp?.fixed.length ? " t-holds" : ""}`}>{cmp ? cmp.fixed.length : "–"}</span>
        </div>
        <div className="sum-cell">
          <span className="sum-label">Regressed</span>
          <span className={`sum-value${cmp?.regressed.length ? " t-breaks" : ""}`}>{cmp ? cmp.regressed.length : "–"}</span>
        </div>
        <div className="sum-cell">
          <span className="sum-label">
            No clear change <Help>Fixed and regressed need the 95% interval of the change to sit clearly on one side of zero. Leaning says which way the rest moved.</Help>
          </span>
          <span className="sum-value">
            {cmp ? cmp.same.length : "–"}{" "}
            {cmp && (better || worse) ? (
              <span className="quiet small">{[better ? `${better} leaning better` : "", worse ? `${worse} leaning worse` : ""].filter(Boolean).join(" · ")}</span>
            ) : null}
          </span>
        </div>
        <div className="sum-cell">
          <span className="sum-label">Pass rate</span>
          <span className="sum-value">
            {pct(da)} → {pct(db)}
          </span>
        </div>
        <div className="sum-cell">
          <span className="sum-label">Cost</span>
          <span className="sum-value">{usd(after.summary.cost_usd)}</span>
        </div>
      </div>

      <section className="block" aria-labelledby="per-h">
        <h2 id="per-h" className="block-h">
          Promise by promise
        </h2>
        <div className="table-wrap">
          <table className="rtable cmp">
            <thead>
              <tr>
                <th>Promise</th>
                <th>Before</th>
                <th>After</th>
                <th className="num">Change</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([id, r]) => (
                <tr key={id} onClick={() => nav(promiseHref(after.scenario, id))} title={r.sentence}>
                  <td>
                    <span className="rule-ref">{id}</span> {rules[id]?.title}
                    <span className="cell-sub">{r.sentence}</span>
                  </td>
                  <td>{r.before ? <VerdictChip verdict={r.before.verdict} /> : <Chip tone="skip">not checked</Chip>}</td>
                  <td>{r.after ? <VerdictChip verdict={r.after.verdict} /> : <Chip tone="skip">not re-run</Chip>}</td>
                  <td className="num">
                    {r.delta !== undefined ? (
                      <>
                        {r.delta > 0 ? "+" : r.delta < 0 ? "−" : ""}
                        {Math.abs(Math.round(r.delta * 100))} pts
                        {r.lo !== undefined && r.hi !== undefined && (
                          <span className="cell-sub">
                            {Math.round(r.lo * 100)} to {Math.round(r.hi * 100)}
                          </span>
                        )}
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td>
                    <ChangeChip row={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="block" aria-labelledby="what-h">
        <h2 id="what-h" className="block-h">
          What changed in between
        </h2>
        {parts.length === 0 && modelChanges.length === 0 ? (
          <p className="quiet">Same prompt and models: differences come from the agent's randomness (and any new tests).</p>
        ) : (
          <div className="changes">
            {modelChanges.map((k) => (
              <p key={k} className="small">
                <Chip>model</Chip> {k}: {ma![k]} → {mb![k]}
              </p>
            ))}
            {parts.map((p) => (
              <div key={p.n} className="diffbox">
                <p className="diffbox-h">
                  <span className="doc-hash">##</span> {partLabel(p.n)} {p.a === undefined ? <Chip tone="holds">new part</Chip> : p.b === undefined ? <Chip tone="breaks">removed</Chip> : null}
                </p>
                <DiffText a={p.a ?? ""} b={p.b ?? ""} />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/** The previous finished check of the same project, for "compare with previous". */
export function usePreviousCheck(run: Run): string | undefined {
  const { runs } = useAppData();
  return (runs ?? [])
    .filter((r) => r.kind === "eval" && r.scenario === run.scenario && r.created < run.created && r.status !== "running")
    .sort((a, b) => b.created - a.created)[0]?.id;
}

export function Sparkline({ values, width = 96, height = 24 }: { values: number[]; width?: number; height?: number }): ReactNode {
  if (values.length < 2) return <span className="spark" style={{ width, height }} />;
  const x = (i: number) => (i / (values.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 2 - v * (height - 4);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="2.5" />
    </svg>
  );
}

// keep the hook lint happy when a page mounts before data arrives
export function useOnce(fn: () => void) {
  useEffect(fn, []); // eslint-disable-line react-hooks/exhaustive-deps
}
