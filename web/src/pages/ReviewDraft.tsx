// Step 2 of a new project: the prompt as a document with the drafted promises as margin notes. Everything here is
// edited with the same in-place pieces as a saved project (prompt parts, promises, tests, setup); nothing reaches
// the server until "Save".
import { useCallback, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, saveScenario, startRun } from "../lib/api";
import { bestSentence } from "../lib/anchor";
import { newCaseFor, slugify } from "../lib/draft";
import { clearDraft, putDraft, takeDraft } from "../lib/draftStore";
import { LocalEditing, useEditing } from "../lib/edit";
import { useDocumentTitle } from "../lib/hooks";
import { runHref, scenarioHref } from "../lib/routes";
import type { Draft, Rule } from "../lib/types";
import { estimate } from "../lib/words";
import { DocHead } from "../components/bits";
import { Help } from "../components/Stats";
import { Drawer, HotProvider, PromptDoc, useHotProps, type Mark } from "../components/Doc";
import { Editable } from "../components/Editable";
import { AddPart, PartMenu, PartName } from "../components/PartEdit";
import { AddPromise, DrafterNotes, notesLabel, useDeletePromise, usePromiseFields } from "../components/PromiseEdit";
import { FlowSteps, KindBadge } from "../components/promise";
import { SetupSections } from "../components/Setup";
import { TestRow } from "../components/TestEditor";

/** A drafted promise in the margin: name, words and part edited in place. */
function PromiseNote({ rule, section, tests, onTests }: { rule: Rule; section: string | null; tests: number; onTests: () => void }) {
  const { isHot, props } = useHotProps(rule.id, section);
  const f = usePromiseFields(rule);
  const del = useDeletePromise();
  return (
    <div className={`note note-edit${isHot ? " is-hot" : ""}${tests ? "" : " is-warn"}`} id={`promise-${rule.id}`} {...props}>
      <span className="note-top">
        <span className="rule-ref">{rule.id}</span>
        <span className="note-part">{f.part}</span>
      </span>
      <span className="note-title">{f.title}</span>
      <span className="note-text note-text-full">{f.text}</span>
      <span className="note-foot">
        <button type="button" className="link-btn" onClick={onTests}>
          {tests ? `${tests} test${tests === 1 ? "" : "s"}` : "No tests: won't be checked"}
        </button>
        <button type="button" className="link-btn quiet-btn" onClick={() => del(rule.id)}>
          Delete
        </button>
      </span>
    </div>
  );
}

function Review() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { draft, update } = useEditing();
  const d = draft!;
  const [k, setK] = useState(d.defaults?.k ?? 3);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const sections = Object.keys(d.sections);
  const panel = params.get("tests");
  const close = useCallback(() => setParams({}, { replace: true }), [setParams]);
  const casesFor = (id: string) => d.cases.filter((c) => c.checks.some((ch) => ch.rule === id));
  const at = (name: string | null) => d.rules.filter((r) => (r.source_section && sections.includes(r.source_section) ? r.source_section : null) === name);

  const runs = d.cases.length * k;
  const est = estimate(runs);
  const nameOk = /^[a-z0-9][a-z0-9-]*$/.test(d.name);
  const untested = d.rules.filter((r) => !casesFor(r.id).length);

  const go = async (andRun: boolean, overwrite = false) => {
    setBusy(andRun ? "run" : "save");
    setErr(null);
    setTaken(false);
    try {
      const { name } = await saveScenario(d, overwrite);
      clearDraft();
      if (andRun) {
        const { id } = await startRun({ kind: "eval", scenario: name, k, cases: null, judge: true });
        nav(runHref(id));
      } else nav(scenarioHref(name));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setTaken(true);
      else setErr((e as Error).message);
      setBusy(null);
    }
  };

  const marks = (name: string): Mark[] =>
    at(name).flatMap((r) => {
      const i = bestSentence(d.sections[name], r);
      return i === null ? [] : [{ key: r.id, sentence: i, tone: "plain" as const }];
    });
  const card = (r: Rule, section: string | null) => <PromiseNote key={r.id} rule={r} section={section} tests={casesFor(r.id).length} onTests={() => setParams({ tests: r.id })} />;
  const unplaced = at(null);
  const openRule = panel ? d.rules.find((r) => r.id === panel) : undefined;
  const byPromise = d.rules.map((r) => ({ r, cs: d.cases.filter((c) => c.checks[0]?.rule === r.id) }));
  const orphans = d.cases.filter((c) => !d.rules.some((r) => r.id === c.checks[0]?.rule));

  return (
    <div className="page has-dock">
      <DocHead
        title={<Editable value={d.title || d.name} label="project name" onSave={(v) => update((x) => ({ ...x, title: v === x.name ? "" : v }))} />}
        sub={
          <>
            <Editable value={d.description} label="description" multiline allowEmpty placeholder="What the agent does, in one line" onSave={(v) => update((x) => ({ ...x, description: v.replace(/\s*\n\s*/g, " ") }))} />
            <p className="slug-line small quiet">
              Saved as{" "}
              <Editable
                value={d.name}
                label="folder and CLI name"
                className="mono"
                validate={(v) => (slugify(v) ? null : "Use letters, digits or dashes")}
                onSave={(v) => {
                  setTaken(false);
                  return update((x) => ({ ...x, name: slugify(v) }));
                }}
              />{" "}
              <Help>{`The folder scenarios/${d.name}, the URL and the name you use in the CLI.`}</Help>
            </p>
          </>
        }
        meta={[`${d.rules.length} promises`, `${sections.length} parts`, `${d.cases.length} test conversations`, `${d.tools.length} simulated tools`]}
        kicker={<FlowSteps at={2} />}
      />

      <div className="doc-frame-head">
        <span className="quiet">Promises sit next to the part they come from</span>
        <Help>Click any text to change it: the prompt, a part's name, a promise, a test. Delete what you don't care about, add what we missed.</Help>
      </div>

      <article className="sheet">
        <PromptDoc
          sections={d.sections}
          marks={marks}
          renderHead={(s) => <PartName name={s} />}
          headAction={(s) => <PartMenu name={s} />}
          renderText={(s) => (
            <Editable
              value={d.sections[s]}
              label={`text of ${s}`}
              multiline
              enter="newline"
              className="doc-p"
              onSave={(v) => update((x) => ({ ...x, sections: { ...x.sections, [s]: v } }))}
            />
          )}
          margin={(name) => (
            <>
              {at(name).map((r) => card(r, name))}
              <AddPromise section={name} />
            </>
          )}
          lead={
            d.notes.length > 0 || unplaced.length > 0
              ? {
                  label: d.notes.length ? notesLabel(d.notes.length) : "Promises about the whole prompt",
                  body: d.notes.length ? <DrafterNotes /> : undefined,
                  notes: unplaced.map((r) => card(r, null)),
                }
              : undefined
          }
          after={<AddPart />}
        />
      </article>

      <section className="appendix" aria-labelledby="tests">
        <h2 id="tests" className="appendix-h">
          All test conversations ({d.cases.length})
        </h2>
        <p className="quiet small legend-kinds">
          <KindBadge kind="plain" /> an ordinary customer <KindBadge kind="trap" /> pushes the agent to break the promise{" "}
          <KindBadge kind="lookalike" /> looks like a trap but isn't. Open a test to change any part of it.
        </p>
        <div className="by-promise">
          {byPromise.map(({ r, cs }) => (
            <section key={r.id} className="bp-group">
              <h3 className="bp-head">
                <span className="rule-ref">{r.id}</span> {r.title || <span className="quiet">untitled promise</span>}
                <span className="quiet bp-count">{cs.length ? `${cs.length} test${cs.length === 1 ? "" : "s"}` : "no tests"}</span>
              </h3>
              {cs.length > 0 && (
                <ul className="tcases">
                  {cs.map((c) => (
                    <TestRow key={c.id} c={c} rules={d.rules} tools={d.tools} />
                  ))}
                </ul>
              )}
              <AddTest rule={r} />
            </section>
          ))}
          {orphans.length > 0 && (
            <section className="bp-group">
              <h3 className="bp-head">Other tests</h3>
              <ul className="tcases">
                {orphans.map((c) => (
                  <TestRow key={c.id} c={c} rules={d.rules} tools={d.tools} />
                ))}
              </ul>
            </section>
          )}
        </div>
      </section>

      <section className="appendix" aria-labelledby="setup">
        <h2 id="setup" className="appendix-h">
          Setup
        </h2>
        <p className="quiet small">A model plays the backend and stays consistent with these facts. Nothing real is called.</p>
        <SetupSections headingLevel={3} />
      </section>

      <div className="dock" role="region" aria-label="Save and run">
        <div className="dock-inner">
          <div className="dock-text">
            {!nameOk ? (
              <span className="form-error">The project name can use lowercase letters, digits and dashes.</span>
            ) : (
              <span>
                <label className="dock-k">
                  <input type="number" min={1} max={10} value={k} onChange={(e) => setK(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} aria-label="Tries per test" />{" "}
                  tries
                </label>{" "}
                × {d.cases.length} tests = <b>{runs} conversations</b>, about <b>{est.usd}</b> and <b>{est.time}</b>
                {untested.length > 0 && <span className="is-warn-text"> · {untested.map((r) => r.id).join(", ")} untested</span>}
              </span>
            )}
            {err && <span className="form-error"> {err}</span>}
          </div>
          <div className="dock-actions">
            <button type="button" className="btn btn-line" disabled={busy !== null || !nameOk} onClick={() => go(false)}>
              {busy === "save" ? "Saving…" : "Save only"}
            </button>
            <button type="button" className="btn btn-ink" disabled={busy !== null || !nameOk || !d.cases.length} onClick={() => go(true)}>
              {busy === "run" ? "Starting…" : "Save and run check"}
            </button>
          </div>
        </div>
        {taken && (
          <div className="form-error dock-taken">
            <p>
              A project called <b>{d.name}</b> already exists.{" "}
              <button type="button" className="link-btn" onClick={() => go(true, true)}>
                Replace it and run
              </button>{" "}
              or change “Saved as” at the top.
            </p>
          </div>
        )}
      </div>

      <Drawer open={!!openRule} onClose={close} label="Tests for this promise">
        {openRule && (
          <div className="panel">
            <p className="panel-kicker">
              <span className="rule-ref">{openRule.id}</span> tests
            </p>
            <h2 className="panel-title">{openRule.title || "Untitled promise"}</h2>
            {openRule.text && <blockquote className="rule-quote">{openRule.text}</blockquote>}
            {casesFor(openRule.id).length ? (
              <ul className="tcases">
                {casesFor(openRule.id).map((c, i) => (
                  <TestRow key={c.id} c={c} rules={d.rules} tools={d.tools} startOpen={i === 0} />
                ))}
              </ul>
            ) : (
              <p className="quiet">Nothing tests this promise yet, so it won't be checked.</p>
            )}
            <AddTest rule={openRule} />
          </div>
        )}
      </Drawer>
    </div>
  );
}

function AddTest({ rule }: { rule: Rule }) {
  const { update } = useEditing();
  return (
    <button
      type="button"
      className="add-note add-test"
      onClick={() => update((x) => ({ ...x, cases: [...x.cases, newCaseFor(rule, x.cases)] }))}
    >
      + Add a test for {rule.id}
    </button>
  );
}

export function ReviewDraft() {
  useDocumentTitle("Review the promises");
  const [draft, setDraft] = useState<Draft | null>(takeDraft);
  const onChange = useCallback((d: Draft) => {
    setDraft(d);
    putDraft(d);
  }, []);
  if (!draft)
    return (
      <div className="page">
        <DocHead title="Nothing to review" sub={<p>No draft here. <Link to="/check">Paste a prompt</Link> to make one.</p>}>
          <FlowSteps at={2} />
        </DocHead>
      </div>
    );
  return (
    <LocalEditing draft={draft} onChange={onChange}>
      <HotProvider>
        <Review />
      </HotProvider>
    </LocalEditing>
  );
}

/** The old /edit page: everything is edited where it is shown now. */
export function EditRedirect() {
  const { name = "" } = useParams();
  return <Navigate to={`${scenarioHref(name)}/prompt`} replace />;
}
