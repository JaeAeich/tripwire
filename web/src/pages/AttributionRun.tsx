// The map: the prompt as a document, and in the margin of each part, which promises it holds up and which it breaks.
import { Link } from "react-router-dom";
import { bestSentence } from "../lib/anchor";
import { useRules } from "../lib/context";
import { claimOf, MAYBE_DELTA, sectionClaims, topSentence, type Claim } from "../lib/attribution";
import { pct, usd } from "../lib/format";
import { compareHref, scenarioHref } from "../lib/routes";
import type { AttributionSummary, Cell, Rule, Run } from "../lib/types";
import { HotProvider, Note, PromptDoc, type Mark, type Tone } from "../components/Doc";
import { Heatmap } from "../components/Heatmap";
import { ProjectFrame } from "../components/ProjectFrame";
import { RunMeta } from "../components/RunHead";
import { Help, StatStrip } from "../components/Stats";
import { Chip } from "../components/Chip";

export function finding(c: Cell, rules: Record<string, Rule>): string {
  const r = `${c.rule}${rules[c.rule] ? ` (${rules[c.rule].title})` : ""}`;
  if (c.delta < 0) return `Taking out ‘${c.section}’ cut how often ${r} broke from ${pct(c.base_rate)} to ${pct(c.ablated_rate)}.`;
  return `Taking out ‘${c.section}’ raised how often ${r} broke from ${pct(c.base_rate)} to ${pct(c.ablated_rate)}.`;
}

export function claimTone(cl: Claim): Tone {
  return cl.effect === "holds" ? (cl.sure === "clear" ? "up" : "maybe-up") : cl.sure === "clear" ? "cause" : "maybe-cause";
}

/** Two thin bars: how often the promise broke with the part, and without it. */
function PairBars({ c, effect }: { c: Cell; effect: Claim["effect"] }) {
  return (
    <span className="pair" aria-hidden="true">
      <span className="pair-row">
        <span className="pair-label">with</span>
        <span className="pair-track">
          <span className="pair-fill is-with" style={{ width: `${Math.max(1, c.base_rate * 100)}%` }} />
        </span>
        <span className="pair-num">{pct(c.base_rate)}</span>
      </span>
      <span className="pair-row">
        <span className="pair-label">without</span>
        <span className="pair-track">
          <span className={`pair-fill is-${effect}`} style={{ width: `${Math.max(1, c.ablated_rate * 100)}%` }} />
        </span>
        <span className="pair-num">{pct(c.ablated_rate)}</span>
      </span>
    </span>
  );
}

export function claimVerb(claim: Claim) {
  const may = claim.sure === "maybe";
  return claim.effect === "holds" ? (may ? "May hold up" : "Holds up") : may ? "May break" : "Breaks";
}

/** A margin note from the map: "holds R3 up" / "breaks R7". */
export function MapNote({ claim, rules, runId, full }: { claim: Claim; rules: Record<string, Rule>; runId: string; full?: boolean }) {
  const c = claim.cell;
  return (
    <Note hotKey={c.rule} section={c.section} tone={claimTone(claim)}>
      <span className="note-top">
        <Chip tone={claim.effect === "holds" ? "holds" : "breaks"} dot>
          {claimVerb(claim)}
        </Chip>
        <span className="rule-ref">{c.rule}</span>
        {claim.sure === "maybe" && <Help>A big gap, but with this many replays it could still be chance.</Help>}
      </span>
      <span className="note-title">{rules[c.rule]?.title ?? c.rule}</span>
      {full ? (
        <PairBars c={c} effect={claim.effect} />
      ) : (
        <span className="note-text small">
          {pct(c.ablated_rate)} broken without this part, {pct(c.base_rate)} with
        </span>
      )}
      <Link to={compareHref(runId, c.section, c.rule)} className="note-link">
        Compare →
      </Link>
    </Note>
  );
}

export function AttributionRun({ run }: { run: Run }) {
  return (
    <ProjectFrame name={run.scenario} tab="map" runId={run.id}>
      <MapBody run={run} />
    </ProjectFrame>
  );
}

export function MapBody({ run }: { run: Run }) {
  return (
    <HotProvider>
      <MapInner run={run} />
    </HotProvider>
  );
}

function MapInner({ run }: { run: Run }) {
  const rules = useRules(run.scenario);
  const s = run.summary as Partial<AttributionSummary>;
  const matrix = s.matrix ?? [];
  const sections = run.config.sections ?? [...new Set(matrix.map((m) => m.section))];
  const ruleIds = [...new Set([...Object.keys(s.base_rates ?? {}), ...matrix.map((m) => m.rule)])].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const prompt = run.config.prompt ?? {};
  const k = s.k ?? run.config.k ?? 0;
  const cases = run.config.cases ?? [];
  const total = run.config.total_trials ?? cases.length * k * (sections.length + 1);
  const done = s.done ?? run.trials.length;
  const ups = matrix.filter((c) => c.role === "load-bearing").length;
  const causes = matrix.filter((c) => c.role === "culprit").length;
  const maybes = matrix.filter((c) => c.role === "unclear" && Math.abs(c.delta) >= MAYBE_DELTA).length;
  const top = topSentence(s);
  const running = run.status === "running";

  const marks = (name: string): Mark[] =>
    // only "holds up" gets a sentence: for a cause we know the part, not which line in it
    sectionClaims(matrix, name)
      .filter((cl) => cl.effect === "holds")
      .flatMap((cl) => {
        const r = rules[cl.cell.rule];
        const i = r ? bestSentence(prompt[name], r) : null;
        return i === null ? [] : [{ key: cl.cell.rule, sentence: i, tone: claimTone(cl) }];
      });
  const edge = (name: string): Tone | undefined => {
    const cl = sectionClaims(matrix, name)[0];
    return cl ? claimTone(cl) : undefined;
  };
  const margin = (name: string) => {
    if (!sections.includes(name)) return <p className="margin-quiet">Not taken out</p>;
    const cells = matrix.filter((c) => c.section === name);
    if (!cells.length) return <p className="margin-quiet">{running ? "Waiting…" : "No data"}</p>;
    const claims = sectionClaims(matrix, name);
    const quiet = cells.filter((c) => !claimOf(c)).map((c) => c.rule);
    return (
      <>
        {claims.map((cl) => (
          <MapNote key={cl.cell.rule} claim={cl} rules={rules} runId={run.id} full />
        ))}
        {quiet.length > 0 && <p className="margin-quiet">No effect on {quiet.join(", ")}</p>}
        {claims.some((c) => c.effect === "causes") && (
          <Link to={`${scenarioHref(run.scenario)}/fix`} className="margin-fix">
            Fix this part <Chip>soon</Chip>
          </Link>
        )}
      </>
    );
  };

  return (
    <>
      <RunMeta run={run} title={top ?? (running ? "Drawing the map…" : "No part clearly changed any promise")} />
      <StatStrip
        items={[
          { label: "Holds up", value: ups, tone: "holds", help: "Parts that, when taken out, make a promise break more often." },
          { label: "Breaks", value: causes, tone: "breaks", help: "Parts that, when taken out, make a promise break less often: they cause the failure." },
          { label: "Maybe", value: maybes, tone: "too_few", help: "A big gap that could still be chance. More replays would settle it." },
          { label: "Parts tested", value: `${sections.length}`, sub: `${cases.length} failing tests` },
          { label: "Replays", value: done, sub: `of ${total} · ${k} per version` },
          { label: "Cost", value: usd(s.cost_usd ?? 0) },
        ]}
      />

      <div className="doc-frame">
        <div className="doc-frame-head">
          <span className="lg lg-up">holds a promise up</span>
          <span className="lg lg-cause">part makes a promise break</span>
          <Help>We replayed the failing tests with one part of the prompt taken out at a time. Pale notes are maybes.</Help>
        </div>
        <article className="sheet">
          <PromptDoc sections={prompt} marks={marks} edge={edge} margin={margin} dim={(n) => !sections.includes(n)} />
        </article>
      </div>

      {matrix.length > 0 && (
        <section className="block" aria-labelledby="table">
          <h2 id="table" className="block-h">
            Every part × every promise
            <Help>Each cell: how often the promise broke with the full prompt → without that part. Click to compare the conversations.</Help>
          </h2>
          <div className="panelbox panelbox-pad">
            <Heatmap runId={run.id} matrix={matrix} sections={sections} rules={rules} ruleIds={ruleIds} />
          </div>
        </section>
      )}
    </>
  );
}
