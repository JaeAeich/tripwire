// One cell of the map: the same tests with the full prompt and without one part, side by side.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRules, useScenario } from "../lib/context";
import { pct, variantLabel } from "../lib/format";
import { useDocumentTitle, useRun } from "../lib/hooks";
import { runHref, trialHref } from "../lib/routes";
import type { AttributionSummary, Rule, Trial } from "../lib/types";
import { DocHead, ErrorNote, Loading } from "../components/bits";
import { ProjectFrame } from "../components/ProjectFrame";
import { Transcript, VerdictList } from "../components/Transcript";
import { finding } from "./AttributionRun";

const broke = (t: Trial, rule: string) => t.verdicts.some((v) => v.rule === rule && !v.passed && !v.error);
const checks = (t: Trial, rule: string) => t.verdicts.some((v) => v.rule === rule);
const key = (t: Trial) => `${t.variant}|${t.case_id}|${t.trial}`;

function Ticks({
  trials,
  rule,
  selected,
  onPick,
  label,
}: {
  trials: Trial[];
  rule: string;
  selected: string | null;
  onPick: (t: Trial) => void;
  label: string;
}) {
  return (
    <div className="ticks" role="group" aria-label={label}>
      {trials.map((t) => {
        const bad = broke(t, rule);
        const k = key(t);
        const w = t.error ? "couldn't run" : bad ? "broken" : "kept";
        return (
          <button
            key={k}
            type="button"
            className={`tk ${t.error ? "tk-skip" : bad ? "tk-fail" : "tk-pass"}${selected === k ? " is-selected" : ""}`}
            aria-pressed={selected === k}
            aria-label={`${label}, try ${t.trial + 1}: ${rule} ${w}`}
            title={`try ${t.trial + 1}: ${rule} ${w}`}
            onClick={() => onPick(t)}
          />
        );
      })}
    </div>
  );
}

function Pane({ runId, trial, rule, title, rules }: { runId: string; trial: Trial | undefined; rule: string; title: string; rules: Record<string, Rule> }) {
  if (!trial)
    return (
      <div className="pane">
        <p className="quiet">Pick a try above.</p>
      </div>
    );
  const bad = broke(trial, rule);
  return (
    <div className="pane">
      <div className="pane-head">
        <h3>{title}</h3>
        <p className="small">
          <span className={bad ? "is-bad" : "is-good"}>
            {rule} {bad ? "broken" : "kept"}
          </span>{" "}
          <span className="quiet">
            · test {trial.case_id}, try {trial.trial + 1} ·{" "}
          </span>
          <Link to={trialHref(runId, trial)}>Open on its own</Link>
        </p>
      </div>
      <VerdictList verdicts={trial.verdicts} rules={rules} onlyRule={rule} />
      <Transcript trial={trial} onlyRule={rule} idPrefix={`${trial.variant}-${trial.case_id}-${trial.trial}`} autoScroll={false} />
    </div>
  );
}

export function ComparePage() {
  const { id, section = "", rule = "" } = useParams();
  const run = useRun(id);
  const rules = useRules(run.data?.scenario);
  const scn = useScenario(run.data?.scenario);
  useDocumentTitle(`${section} × ${rule}`);
  const variant = `ablate:${section}`;

  const cell = (run.data?.summary as Partial<AttributionSummary> | undefined)?.matrix?.find((m) => m.section === section && m.rule === rule);
  const caseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of run.data?.trials ?? []) if (checks(t, rule)) ids.add(t.case_id);
    return [...ids].sort();
  }, [run.data, rule]);
  const of = (v: string, cid: string) => (run.data?.trials ?? []).filter((t) => t.variant === v && t.case_id === cid).sort((a, b) => a.trial - b.trial);

  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);

  // default pair: a base trial that broke the rule next to an ablated one that went the other way, same case
  useEffect(() => {
    if (!run.data || left || right) return;
    for (const cid of caseIds) {
      const b = of("base", cid);
      const a = of(variant, cid);
      const bBad = b.find((t) => broke(t, rule));
      const aDiff = bBad ? a.find((t) => !broke(t, rule)) : a.find((t) => broke(t, rule));
      const bPick = bBad ?? b.find((t) => !broke(t, rule));
      if (bPick && aDiff) {
        setLeft(key(bPick));
        setRight(key(aDiff));
        return;
      }
    }
    const cid = caseIds[0];
    if (cid) {
      const b = of("base", cid)[0];
      const a = of(variant, cid)[0];
      if (b) setLeft(key(b));
      if (a) setRight(key(a));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.data, caseIds]);

  if (run.error && !run.data) return <div className="page"><ErrorNote error={run.error} what="run" /></div>;
  if (!run.data) return <div className="page"><Loading what="comparison" /></div>;
  const byKey = new Map(run.data.trials.map((t) => [key(t), t]));
  const sectionText = run.data.config.prompt?.[section];

  return (
    <ProjectFrame name={run.data.scenario} tab="map" runId={run.data.id}>
      <DocHead
        crumbs={[
          { to: runHref(run.data.id), label: "← Map" },
          { label: `${section} × ${rule}` },
        ]}
        title={
          <>
            {rule} {rules[rule]?.title ?? ""}, with and without ‘{section}’
          </>
        }
        sub={cell ? <p>{finding(cell, rules)}</p> : undefined}
        meta={
          cell
            ? [`full prompt: broke ${pct(cell.base_rate)}`, `without it: ${pct(cell.ablated_rate)}`, `${cell.n[0]} and ${cell.n[1]} replays`]
            : undefined
        }
      />

      {sectionText && (
        <article className={`sheet sheet-quote${cell?.role === "culprit" ? " edge-cause" : cell?.role === "load-bearing" ? " edge-up" : ""}`}>
          <p className="label">The part we took out</p>
          <h3 className="doc-h">
            <span className="doc-hash">##</span>
            {section}
          </h3>
          <p className="doc-p">{sectionText}</p>
        </article>
      )}

      <section className="appendix" aria-labelledby="pick">
        <h2 id="pick" className="appendix-h">
          Pick a try on each side
        </h2>
        <ol className="compare-cases">
          {caseIds.map((cid) => {
            const c = scn?.cases.find((x) => x.id === cid);
            const b = of("base", cid);
            const a = of(variant, cid);
            return (
              <li key={cid} className="compare-case">
                <p className="case-title">{c?.title ?? `Test ${cid}`}</p>
                <div className="compare-rows">
                  <span className="quiet small">full prompt</span>
                  <Ticks trials={b} rule={rule} selected={left} onPick={(t) => setLeft(key(t))} label={`test ${cid}, full prompt`} />
                  <span className="quiet small">
                    broke {b.filter((t) => broke(t, rule)).length} of {b.length}
                  </span>
                  <span className="quiet small">{variantLabel(variant)}</span>
                  <Ticks trials={a} rule={rule} selected={right} onPick={(t) => setRight(key(t))} label={`test ${cid}, ${variantLabel(variant)}`} />
                  <span className="quiet small">
                    broke {a.filter((t) => broke(t, rule)).length} of {a.length}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="compare">
        <Pane runId={run.data.id} trial={left ? byKey.get(left) : undefined} rule={rule} rules={rules} title="With the full prompt" />
        <Pane runId={run.data.id} trial={right ? byKey.get(right) : undefined} rule={rule} rules={rules} title={`Without ‘${section}’`} />
      </div>
    </ProjectFrame>
  );
}
