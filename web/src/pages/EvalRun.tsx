// The report: the prompt as a document, each promise pinned in the margin next to the part it comes from, with its
// verdict. Click a promise for its tests, tries and the transcripts where it broke.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getRun, startRun } from "../lib/api";
import { bestSentence, placeRules } from "../lib/anchor";
import { sectionClaims, topSentence, type Claim } from "../lib/attribution";
import { useAppData, useRules, useScenario } from "../lib/context";
import { pct, plural, usd } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { runHref } from "../lib/routes";
import type { AttributionSummary, EvalSummary, IndexEntry, Rule, RuleStat, RuleVerdict, Run, Trial, Verdict } from "../lib/types";
import { brokeCheck, readRule, shortSentence, tally, tallyWords, VERDICT_WORDS } from "../lib/words";
import { Drawer, HotProvider, Note, partLabel, PromptDoc, slug, type Mark, type Tone } from "../components/Doc";
import { IntervalBar, VerdictChip } from "../components/promise";
import { RunMeta } from "../components/RunHead";
import { EvidencePanel } from "../components/Evidence";
import { gather } from "../lib/evidence";
import { ProjectFrame } from "../components/ProjectFrame";
import { Help, VerdictBar, verdictCounts } from "../components/Stats";
import { compareRunsHref, usePreviousCheck } from "./Project";
import { TrialGrid } from "../components/TrialGrid";
import { claimVerb, MapNote } from "./AttributionRun";
import { Chip } from "../components/Chip";

const FALLBACK_TRIAL_USD = 0.016;
const ORDER: Record<RuleVerdict, number> = { breaks: 0, flaky: 1, too_few: 2, holds: 3 };

interface Miss {
  trial: Trial;
  verdicts: Verdict[];
}


// ---------- find the cause (attribution) ----------

function AttributeForm({ run, failing }: { run: Run; failing: string[] }) {
  const nav = useNavigate();
  const all = (run.config.sections ?? Object.keys(run.config.prompt ?? {})).filter((s) => s !== "preamble");
  const [k, setK] = useState(5);
  const [picked, setPicked] = useState<string[]>(all);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const trials = failing.length * k * (1 + picked.length);
  const costs = run.trials.map((t) => t.cost_usd).filter((c) => c > 0);
  const perTrial = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : FALLBACK_TRIAL_USD;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const { id } = await startRun({ kind: "attribute", base_run: run.id, k, sections: picked.length === all.length ? null : picked });
      nav(runHref(id));
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="panel-form" onSubmit={submit}>
      <p>
        We replay the {plural(failing.length, "failing test")} {k} times with your full prompt, then {k} times more for each
        part with that part taken out. If a promise breaks <em>more</em> without a part, that part holds it up. If it breaks{" "}
        <em>less</em>, that part is causing it.
      </p>
      <fieldset className="field">
        <legend className="label">Parts to try taking out</legend>
        <div className="checks">
          {all.map((s) => (
            <label key={s} className="check">
              <input
                type="checkbox"
                checked={picked.includes(s)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))}
              />
              <span>{s}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field field-inline">
        <input type="number" min={2} max={20} value={k} onChange={(e) => setK(Math.max(2, Number(e.target.value) || 2))} />
        <span>tries per version. More is slower but less noisy.</span>
      </label>
      <p className="estimate">
        {trials} conversations, about <b>{usd(trials * perTrial)}</b> at {usd(perTrial)} each.
      </p>
      <div className="form-actions">
        <button type="submit" className="btn btn-ink" disabled={busy || !picked.length}>
          {busy ? "Starting…" : "Find the cause"}
        </button>
        {err && <span className="form-error">{err}</span>}
      </div>
    </form>
  );
}

// ---------- margin bits ----------

const toneOf = (v: RuleVerdict): Tone => v;

function PromiseNote({
  id,
  rule,
  stat,
  section,
  selected,
  onOpen,
  claim,
}: {
  id: string;
  rule?: Rule;
  stat?: RuleStat;
  section: string | null;
  selected: boolean;
  onOpen: () => void;
  claim?: Claim;
}) {
  const reading = stat ? readRule(stat) : null;
  const verdict: RuleVerdict = reading?.verdict ?? "too_few";
  return (
    <Note hotKey={id} section={section} tone={toneOf(verdict)} onClick={onOpen} selected={selected} label={`${id} ${rule?.title ?? ""}: ${VERDICT_WORDS[verdict].label}. Open details`}>
      <span className="note-top">
        <VerdictChip verdict={verdict} small />
        <span className="rule-ref">{id}</span>
      </span>
      <span className="note-title">{rule?.title ?? id}</span>
      <span className="note-text">{reading ? `${shortSentence(reading.sentence)}.` : "No finished conversation checked it."}</span>
      {reading && stat && verdict !== "holds" && <IntervalBar rate={stat.rate} lo={reading.lo} hi={reading.hi} verdict={verdict} compact />}
      {claim && (
        <span className="note-map">
          <Chip tone={claim.effect === "holds" ? "holds" : "breaks"}>map: {claimVerb(claim).toLowerCase()}</Chip>
          <span className="quiet">
            {pct(claim.cell.ablated_rate)} without · {pct(claim.cell.base_rate)} with
          </span>
        </span>
      )}
    </Note>
  );
}

// ---------- the page ----------

function useLatestAttribution(run: Run) {
  const { runs } = useAppData();
  const attributions = (runs ?? [])
    .filter((r) => r.kind === "attribute" && r.config?.base_run === run.id)
    .sort((a, b) => b.created - a.created);
  const latest: IndexEntry | undefined = attributions.find((a) => a.status === "done") ?? attributions[0];
  const full = useAsync(() => (latest ? getRun(latest.id) : Promise.resolve(null)), [latest?.id, latest?.status, latest?.updated]);
  return { attributions, latest, attr: full.data ?? null };
}

export function EvalRun({ run }: { run: Run }) {
  const [params] = useSearchParams();
  return (
    <HotProvider pinned={params.get("p")}>
      <EvalReport run={run} />
    </HotProvider>
  );
}

function EvalReport({ run }: { run: Run }) {
  const { mode } = useAppData();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const scn = useScenario(run.scenario);
  const rules = useRules(run.scenario);
  const s = run.summary as Partial<EvalSummary>;
  const k = s.k ?? run.config.k ?? 1;
  const caseIds = run.config.cases ?? Object.keys(s.per_case ?? {});
  const cases = useMemo(() => scn?.cases ?? [], [scn]);
  const caseMap = useMemo(() => Object.fromEntries(cases.map((c) => [c.id, c])), [cases]);
  const sections = run.config.prompt ?? scn?.sections ?? {};
  const base = run.trials.filter((t) => t.variant === "base");
  const crashed = base.filter((t) => t.error);
  const running = run.status === "running";
  const finished = run.status === "done" || run.status === "stopped";
  const [moreErr, setMoreErr] = useState<string | null>(null);
  const { attributions, attr } = useLatestAttribution(run);
  const matrix = (attr?.summary as Partial<AttributionSummary> | undefined)?.matrix ?? [];

  const perRule = s.per_rule ?? {};
  const ids = [...new Set([...Object.keys(rules), ...Object.keys(perRule)])];
  const verdictOf = (id: string): RuleVerdict => (perRule[id] ? readRule(perRule[id]).verdict : "too_few");
  const sorted = [...ids].sort((a, b) => ORDER[verdictOf(a)] - ORDER[verdictOf(b)] || a.localeCompare(b, undefined, { numeric: true }));
  const t = tally(perRule, ids);
  const estimated = Object.values(perRule).some((r) => readRule(r).estimated);

  const allRules: Rule[] = ids.map((id) => rules[id] ?? { id, title: id, text: "" });
  const place = useMemo(() => placeRules(sections, allRules), [JSON.stringify(sections), JSON.stringify(allRules)]); // eslint-disable-line react-hooks/exhaustive-deps
  const bySection = (name: string | null) => sorted.filter((id) => (place[id] ?? null) === name);

  const misses = new Map<string, Miss[]>();
  for (const tr of base) {
    if (tr.error) continue;
    for (const rule of new Set(tr.verdicts.filter(brokeCheck).map((v) => v.rule)))
      misses.set(rule, [...(misses.get(rule) ?? []), { trial: tr, verdicts: tr.verdicts.filter((v) => brokeCheck(v) && v.rule === rule) }]);
  }
  const failing = Object.entries(s.per_case ?? {})
    .filter(([, c]) => c.pass_rate < 1)
    .map(([id]) => id);

  const open = params.get("p");
  const finding = params.get("find") === "1";
  const setOpen = useCallback(
    (p: string | null) => setParams(p ? { p } : {}, { replace: !p ? true : false }),
    [setParams],
  );
  const close = useCallback(() => setParams({}, { replace: true }), [setParams]);

  // bring the part a promise comes from into view next to its open panel
  const openSection = open ? place[open] ?? null : null;
  useEffect(() => {
    if (!openSection) return;
    const el = document.getElementById(`part-${slug(openSection)}`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 120 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [openSection]);

  const runMore = async (rule: string) => {
    setMoreErr(null);
    const cs = cases.filter((c) => (c.checks ?? []).some((ch) => ch.rule === rule)).map((c) => c.id);
    try {
      const { id } = await startRun({
        kind: "eval",
        scenario: run.scenario,
        k: Math.min(10, Math.max(5, k + 2)),
        cases: cs.length ? cs : null,
        judge: run.config.judge !== false,
      });
      nav(runHref(id));
    } catch (e) {
      setMoreErr((e as Error).message);
    }
  };

  const marks = (name: string): Mark[] =>
    bySection(name).flatMap((id) => {
      const r = rules[id];
      const i = r ? bestSentence(sections[name], r) : null;
      return i === null ? [] : [{ key: id, sentence: i, tone: toneOf(verdictOf(id)) }];
    });
  const edge = (name: string): Tone | undefined => {
    // only parts with a problem get a change bar; holding parts stay quiet
    const here = bySection(name);
    const v = here.length ? verdictOf(here[0]) : null;
    return v === "breaks" || v === "flaky" ? v : undefined;
  };
  const canFind = mode === "local" && finished && failing.length > 0;

  const margin = (name: string) => {
    const here = bySection(name);
    const claims = sectionClaims(matrix, name);
    const bad = here.some((id) => ["breaks", "flaky"].includes(verdictOf(id)));
    return (
      <>
        {here.map((id) => (
          <PromiseNote
            key={id}
            id={id}
            rule={rules[id]}
            stat={perRule[id]}
            section={name}
            selected={open === id}
            onOpen={() => setOpen(id)}
            claim={claims.find((c) => c.cell.rule === id)}
          />
        ))}
        {claims.filter((cl) => !here.includes(cl.cell.rule)).map((cl) => (
          <MapNote key={cl.cell.rule} claim={cl} rules={rules} runId={attr!.id} />
        ))}
        {(bad || claims.some((c) => c.effect === "causes")) && finished && (
          <div className="margin-actions">
            <Link to={`/scenarios/${encodeURIComponent(run.scenario)}/attack`} className="margin-fix">
              Attack it →
            </Link>
            <Link to={`/scenarios/${encodeURIComponent(run.scenario)}/fix`} className="margin-fix">
              Fix this part <Chip>soon</Chip>
            </Link>
          </div>
        )}
      </>
    );
  };

  const unplaced = bySection(null);
  const top = attr ? topSentence(attr.summary as Partial<AttributionSummary>) : null;

  const c = verdictCounts(perRule, ids);
  const skipped = crashed.length;
  const prevId = usePreviousCheck(run);

  const primary = canFind ? (
    <button type="button" className="btn btn-ink" onClick={() => setParams({ find: "1" })}>
      {attributions.length ? "Map it again" : "Find the cause"}
    </button>
  ) : finished ? (
    <Link to={`/scenarios/${encodeURIComponent(run.scenario)}/attack`} className="btn btn-ink">
      Attack it
    </Link>
  ) : null;
  const menu = [
    ...(prevId ? [{ label: "Compare with the previous check", to: compareRunsHref(run.id, prevId) }] : []),
    ...(attributions.length ? [{ label: "Open the map", to: runHref(attributions[0].id) }] : []),
  ];

  return (
    <ProjectFrame name={run.scenario} tab="runs" runId={run.id} primary={primary} menu={menu}>
      <RunMeta
        run={run}
        title={base.length ? `${running ? "So far: " : ""}${tallyWords(t)}` : running ? "Waiting for the first conversations…" : "No conversations finished"}
      />

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
            Pass rate <Help>Share of conversations where no promise broke, on a typical try (pass@1), with its 95% range.</Help>
          </span>
          <span className="sum-value">
            {pct(s.pass_at_1)} <span className="quiet small">{s.pass_at_1_ci ? `${pct(s.pass_at_1_ci[0])}–${pct(s.pass_at_1_ci[1])}` : ""}</span>
          </span>
        </div>
        <div className="sum-cell">
          <span className="sum-label">
            All {k} tries <Help>{`Share of tests that passed every one of their ${k} tries (pass^${k}): how far you can rely on it.`}</Help>
          </span>
          <span className="sum-value">
            {pct(s.pass_hat_k)} <span className="quiet small">{s.pass_hat_k_ci ? `${pct(s.pass_hat_k_ci[0])}–${pct(s.pass_hat_k_ci[1])}` : ""}</span>
          </span>
        </div>
        <div className="sum-cell">
          <span className="sum-label">
            Conversations{" "}
            {skipped > 0 && <Help>{`${skipped} couldn't run (a problem on our side, like a rate limit) and are not counted.`}</Help>}
          </span>
          <span className="sum-value">
            {base.length - skipped} <span className="quiet small">{skipped ? `${skipped} couldn't run` : `of ${run.config.total_trials ?? base.length}`}</span>
          </span>
        </div>
        <div className="sum-cell">
          <span className="sum-label">Cost</span>
          <span className="sum-value">
            {usd(s.cost_usd)} <span className="quiet small">{base.length ? `${usd((s.cost_usd ?? 0) / base.length)} each` : ""}</span>
          </span>
        </div>
      </div>
      {(s.check_errors ?? 0) > 0 && (
        <p className="skipline">
          <span className="skip-dot" aria-hidden="true" />
          {plural(s.check_errors!, "check")} couldn't be made (not counted)
        </p>
      )}

      <div className="doc-frame">
        <div className="doc-frame-head">
          <span className="lg lg-breaks">breaks</span>
          <span className="lg lg-flaky">flaky</span>
          <span className="lg lg-too_few">not sure</span>
          <Help>Each promise sits next to the part of the prompt it comes from; its line is underlined. Hover a note to find the line, click it for tests and transcripts.</Help>
          <span className="doc-frame-map">
            {attr ? (
              <>
                <span className="map-key" aria-hidden="true" />
                {attr.status === "running" ? "Map being drawn" : "Map shown in the margin"} · <Link to={runHref(attr.id)}>open map</Link>
              </>
            ) : null}
          </span>
        </div>
        {attr && top && <p className="doc-frame-top">{top}</p>}
        <article className="sheet">
          <PromptDoc
            sections={sections}
            marks={marks}
            edge={edge}
            margin={margin}
            tagFor={(key, tone) => (tone === "breaks" || tone === "flaky" || tone === "too_few" ? `${key} · ${tone === "too_few" ? "not sure" : tone}` : null)}
            onPick={(key) => setOpen(key)}
            lead={
              unplaced.length
                ? {
                    label: "Whole prompt",
                    notes: unplaced.map((id) => (
                      <PromiseNote key={id} id={id} rule={rules[id]} stat={perRule[id]} section={null} selected={open === id} onOpen={() => setOpen(id)} />
                    )),
                  }
                : undefined
            }
          />
        </article>
      </div>

      {moreErr && <p className="form-error">{moreErr}</p>}

      <section className="block" aria-labelledby="every">
        <h2 id="every" className="block-h">
          Conversations
          <span className="block-sub">
            {caseIds.length} tests × {k} tries
          </span>
          <Help>A simulated customer plays each test several times, because the agent doesn't answer the same way twice. Click a mark to read it.</Help>
          <span className="block-legend">
            <span className="tk tk-pass is-static" /> kept all <span className="tk tk-fail is-static" /> broke one <span className="tk tk-skip is-static" /> couldn't run
          </span>
        </h2>
        <div className="panelbox">
          <TrialGrid runId={run.id} trials={run.trials} caseIds={caseIds} cases={caseMap} k={k} />
        </div>
        {(estimated || s.min_detectable_effect !== undefined) && (
          <p className="quiet small footnote">
            {estimated && "Saved before tripwire computed ranges: verdicts are rough estimates. "}
            {s.min_detectable_effect !== undefined &&
              `Smallest change between two checks you could tell from chance: about ${Math.round(s.min_detectable_effect > 1 ? s.min_detectable_effect : s.min_detectable_effect * 100)} points.`}
          </p>
        )}
      </section>

      <Drawer open={!!open} onClose={close} label="Evidence" docked>
        {open && scn && (() => {
          const ev = gather({ ...scn, sections }, open, run, attr);
          if (!ev) return null;
          const v = perRule[open] ? readRule(perRule[open]).verdict : "too_few";
          return (
            <EvidencePanel
              e={ev}
              project={run.scenario}
              actions={
                <>
                  {ev.section && (
                    <Link to={`/scenarios/${encodeURIComponent(run.scenario)}/prompt?p=${encodeURIComponent(open)}`} className="btn btn-ink">
                      Edit ‘{partLabel(ev.section)}’
                    </Link>
                  )}
                  {v === "too_few" && mode === "local" && finished && (
                    <button type="button" className="btn btn-line" onClick={() => runMore(open)}>
                      Run its tests more times
                    </button>
                  )}
                </>
              }
            />
          );
        })()}
      </Drawer>
      <Drawer open={finding} onClose={close} label="Find the cause">
        <div className="panel">
          <p className="panel-kicker">The map</p>
          <h2 className="panel-title">Which part of the prompt causes this?</h2>
          {attributions.length > 0 && (
            <p className="small">
              <Link to={runHref(attributions[0].id)}>Open the latest map</Link> <span className="quiet">({plural(attributions.length, "map")} so far)</span>
            </p>
          )}
          {canFind ? <AttributeForm run={run} failing={failing} /> : <p className="quiet">{running ? "Available when this check finishes." : "Nothing broke, so there's nothing to trace."}</p>}
        </div>
      </Drawer>
    </ProjectFrame>
  );
}
