// The evidence panel: everything about one promise, on the page you're on. Top to bottom: the promise and its verdict,
// the map numbers for its part, every conversation where it broke (customer, the failing step highlighted, which
// check failed and why, the whole conversation one click away), its tests, and the actions: edit the part, copy a
// brief for an agent.
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { briefUrl, getBrief, MOCK } from "../lib/api";
import { claimOf } from "../lib/attribution";
import { useAppData } from "../lib/context";
import { briefJSON, briefMarkdown, type Evidence, type Failure } from "../lib/evidence";
import { cut, json, pct, readableDetail } from "../lib/format";
import { trialHref } from "../lib/routes";
import { Chip } from "./Chip";
import { partLabel } from "./Doc";
import { IntervalBar, KindBadge, VerdictChip } from "./promise";
import { Help } from "./Stats";
import { Transcript } from "./Transcript";

const WHO: Record<string, string> = { user: "Customer", agent: "Agent", tool: "Tool call" };

/** Copies the server's brief (GET /api/runs/{id}/brief); falls back to the same brief built here. */
function CopyButton({ get, fallback, label, primary }: { get: () => Promise<string>; fallback: string; label: string; primary?: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  return (
    <button
      type="button"
      className={`btn ${primary ? "btn-ink" : "btn-line"}`}
      disabled={state === "busy"}
      onClick={async () => {
        setState("busy");
        let text = fallback;
        try {
          text = await get();
        } catch {
          /* static demo or older server: use the local brief */
        }
        await navigator.clipboard?.writeText(text).catch(() => undefined);
        setState("done");
        window.setTimeout(() => setState("idle"), 1500);
      }}
    >
      {state === "done" ? "Copied" : state === "busy" ? "Copying…" : label}
    </button>
  );
}

function FailureCard({ f }: { f: Failure }) {
  const [full, setFull] = useState(false);
  const isAttack = f.trial.variant === "attack";
  return (
    <li className="ev-fail">
      <div className="ev-fail-head">
        {isAttack ? <Chip>attack</Chip> : <KindBadge kind={f.case?.kind} />}
        <span className="ev-fail-title">{f.case?.title ?? `Test ${f.trial.case_id}`}</span>
        <span className="quiet small num">
          try {f.trial.trial + 1}
          {f.step !== null ? ` · step ${f.step}` : ""}
        </span>
      </div>
      {(f.case?.persona?.who || f.angle) && (
        <p className="ev-who">
          {f.angle && <Chip>{f.angle}</Chip>} {f.case?.persona?.who}
          {f.case?.persona?.goal ? <span className="quiet"> wants: {String(f.case.persona.goal)}</span> : null}
        </p>
      )}
      <ol className="ev-excerpt">
        {f.excerpt.map((x) => (
          <li key={x.index} className={`ev-turn ev-${x.turn.role}${x.hit ? " is-hit" : ""}`}>
            <span className="ev-turn-who">
              {WHO[x.turn.role] ?? x.turn.role} · {x.index}
              {x.hit && <span className="t-breaks"> · broke here</span>}
            </span>
            {x.turn.tool_call ? (
              <code className="ev-code">
                {x.turn.tool_call.name}({cut(json(x.turn.tool_call.args), 120)}) → {cut(json(x.turn.tool_call.result), 80)}
              </code>
            ) : (
              <span className="ev-text">{x.turn.text}</span>
            )}
          </li>
        ))}
      </ol>
      <ul className="ev-checks">
        {f.verdicts.map((v, i) => (
          <li key={i}>
            <Chip tone="breaks">{v.grader === "judge" ? "judgment" : "exact"}</Chip>
            <span>{readableDetail(v)}</span>
          </li>
        ))}
      </ul>
      <div className="ev-fail-actions">
        <button type="button" className="link-btn" aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? "Hide the conversation" : `Show the whole conversation (${f.trial.turns.length} steps)`}
        </button>
        <Link to={trialHref(f.run.id, f.trial, f.step)} className="quiet small">
          open on its own
        </Link>
      </div>
      {full && (
        <div className="ev-full">
          <Transcript trial={f.trial} activeStep={f.step} autoScroll={false} idPrefix={`ev-${f.run.id}-${f.trial.case_id}-${f.trial.trial}`} />
        </div>
      )}
    </li>
  );
}

export function EvidencePanel({ e, project, actions, head }: { e: Evidence; project: string; actions?: ReactNode; /** replaces the title and text, e.g. with editable ones */ head?: ReactNode }) {
  const { mode } = useAppData();
  const base = e.failures.filter((f) => f.trial.variant !== "attack");
  const atk = e.failures.filter((f) => f.trial.variant === "attack");
  const md = briefMarkdown(e, project);
  const js = JSON.stringify(briefJSON(e, project), null, 2);
  return (
    <div className="panel ev">
      <p className="panel-kicker">
        {e.reading ? <VerdictChip verdict={e.reading.verdict} /> : <Chip>not run</Chip>}
        <span className="rule-ref">{e.rule.id}</span>
      </p>
      {head ?? (
        <>
          <h2 className="panel-title">{e.rule.title}</h2>
          <blockquote className="rule-quote">{e.rule.text}</blockquote>
        </>
      )}
      {e.reading && e.rate !== undefined && (
        <div className="ev-rate">
          <IntervalBar rate={e.rate} lo={e.reading.lo} hi={e.reading.hi} verdict={e.reading.verdict} />
        </div>
      )}

      <div className="ev-actions">
        {actions}
        <CopyButton
          get={() => (e.run ? getBrief(e.run.id, { rule: e.rule.id, format: "md" }) : Promise.reject())}
          fallback={md}
          label="Copy for an agent"
          primary={!actions}
        />
        <CopyButton get={() => (e.run ? getBrief(e.run.id, { rule: e.rule.id, format: "json" }) : Promise.reject())} fallback={js} label="Copy JSON" />
        {e.run && !MOCK && mode === "local" && (
          <a href={briefUrl(e.run.id, { rule: e.rule.id, format: "json" })} target="_blank" rel="noreferrer" className="small">
            JSON link
          </a>
        )}
        <Help>{`A self-contained brief: the promise, its prompt part, map numbers, failing excerpts and what must not regress. Same as: tripwire brief ${e.run?.id ?? "<run>"} --rule ${e.rule.id} (or the MCP tool get_brief).`}</Help>
      </div>

      {e.section && (
        <section className="panel-block">
          <h3 className="panel-h">
            Part: {partLabel(e.section)}
          </h3>
          {e.map ? (
            <p className="ev-map">
              <span>
                With it: broke <b className="num">{e.map.withBroke}</b> of {e.map.withN}
              </span>
              <span>
                Without it: <b className="num">{e.map.withoutBroke}</b> of {e.map.withoutN}
              </span>
              {(() => {
                const cl = claimOf(e.map.cell);
                return cl ? (
                  <Chip tone={cl.effect === "holds" ? "holds" : "breaks"} dot>
                    {cl.effect === "holds" ? (cl.sure === "clear" ? "holds it up" : "may hold it up") : cl.sure === "clear" ? "breaks it" : "may break it"}
                  </Chip>
                ) : (
                  <Chip>no clear effect</Chip>
                );
              })()}
            </p>
          ) : (
            <p className="quiet small">No map for this part yet.</p>
          )}
          {e.map && e.map.cell.section !== e.section && <p className="quiet small">Map numbers are for ‘{partLabel(e.map.cell.section)}’, the part with the biggest effect.</p>}
        </section>
      )}

      <section className="panel-block">
        <h3 className="panel-h">
          Where it broke <span className="quiet">{base.length}</span>
        </h3>
        {base.length ? (
          <ol className="ev-fails">
            {base.map((f, i) => (
              <FailureCard key={`${f.run.id}-${f.trial.case_id}-${f.trial.trial}-${i}`} f={f} />
            ))}
          </ol>
        ) : (
          <p className="quiet small">It didn't break in this check.</p>
        )}
      </section>

      {atk.length > 0 && (
        <section className="panel-block">
          <h3 className="panel-h">
            Broken by attacks <span className="quiet">{atk.length}</span>
          </h3>
          <ol className="ev-fails">
            {atk.map((f, i) => (
              <FailureCard key={`a-${f.run.id}-${f.trial.case_id}-${f.trial.trial}-${i}`} f={f} />
            ))}
          </ol>
        </section>
      )}

      <section className="panel-block">
        <h3 className="panel-h">
          Its tests <span className="quiet">{e.tests.length}</span>
        </h3>
        <ul className="ev-tests">
          {e.tests.map((c) => {
            const ts = e.run ? e.run.trials.filter((t) => t.variant === "base" && t.case_id === c.id).sort((a, b) => a.trial - b.trial) : [];
            return (
              <li key={c.id}>
                <KindBadge kind={c.kind} />
                <span className="ev-test-title">{c.title}</span>
                <span className="ticks">
                  {ts.map((t) => {
                    const bad = t.verdicts.some((v) => v.rule === e.rule.id && !v.passed && !v.error);
                    return <Link key={t.trial} to={trialHref(e.run!.id, t)} className={`tk ${t.error ? "tk-skip" : bad ? "tk-fail" : "tk-pass"}`} title={`try ${t.trial + 1}`} />;
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {e.others.some((o) => o.verdict === "holds") && (
        <section className="panel-block">
          <h3 className="panel-h">Must not regress</h3>
          <p className="ev-guard">
            {e.others
              .filter((o) => o.verdict === "holds")
              .map((o) => (
                <Chip key={o.rule.id} tone="holds" title={o.rule.title}>
                  {o.rule.id}
                </Chip>
              ))}
          </p>
        </section>
      )}
      {e.rate !== undefined && e.reading && <p className="quiet small ev-foot">Broke {pct(e.rate)} of the time in this check.</p>}
    </div>
  );
}
