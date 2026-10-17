// Attack: pick promises, a planner writes hostile customers (each with a harmless look-alike), they play against the
// agent k times, and the attacks that break a promise can be added to the project as tests.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { addCases, ApiError, MOCK, startAttack } from "../lib/api";
import { useAppData, useScenario } from "../lib/context";
import { ago, pct, plural, usd } from "../lib/format";
import { useDocumentTitle } from "../lib/hooks";
import { useRuns } from "../lib/projects";
import { runHref, trialHref } from "../lib/routes";
import type { AttackCase, AttackStat, AttackSummary, AttackTally, IndexEntry, Rule, RuleVerdict, Run } from "../lib/types";
import { TRIAL_USD, estimate, VERDICT_WORDS } from "../lib/words";
import { Loading } from "../components/bits";
import { ProjectFrame, projectRuns } from "../components/ProjectFrame";
import { IntervalBar, KindBadge, VerdictChip } from "../components/promise";
import { RunMeta } from "../components/RunHead";
import { Help, StatStrip } from "../components/Stats";
import { Flow, useLatest, verdictOf } from "./Loop";
import { Chip } from "../components/Chip";

const PLAN_USD = 0.03; // planning is one planner call per promise, roughly

const summaryOf = (run: Run) => run.summary as unknown as Partial<AttackSummary>;

// ---------- the tab: set up a new attack, list past ones ----------

export function ProjectAttack() {
  const { name = "" } = useParams();
  useDocumentTitle(`${name} attack`);
  return (
    <ProjectFrame name={name} tab="attack">
      <AttackTab name={name} />
    </ProjectFrame>
  );
}

function AttackTab({ name }: { name: string }) {
  const scn = useScenario(name);
  const { mode, runs, reloadRuns } = useAppData();
  const { per, evalEntry } = useLatest(name);
  const nav = useNavigate();
  const ranked = useMemo(() => {
    const order: Record<string, number> = { breaks: 0, flaky: 1, too_few: 2, holds: 3 };
    return [...(scn?.rules ?? [])].sort((a, b) => order[verdictOf(per, a.id) ?? "too_few"] - order[verdictOf(per, b.id) ?? "too_few"]);
  }, [scn, per]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [n, setN] = useState(3);
  const [k, setK] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const past = projectRuns(runs, name).filter((r) => r.kind === "attack");
  const details = useRuns(past.slice(0, 10));
  // ?autostart=1 (mock only) starts with the default targets, for screenshots
  const [params] = useSearchParams();
  const auto = useRef(false);
  useEffect(() => {
    if (MOCK && params.get("autostart") && !auto.current && scn && targets.length) {
      auto.current = true;
      go();
    }
  });

  if (!scn) return <Loading what="project" />;
  const targets = picked ?? ranked.filter((r) => ["breaks", "flaky"].includes(verdictOf(per, r.id) ?? "")).map((r) => r.id).slice(0, 3);
  const convs = targets.length * n * 2 * k; // every attack has a look-alike
  const est = estimate(convs);
  const usdTotal = convs * TRIAL_USD + targets.length * PLAN_USD;

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { id } = await startAttack({ scenario: name, rules: targets, per_rule: n, k, base_run: evalEntry?.id, judge: true });
      reloadRuns();
      nav(runHref(id));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="loop">
        <section className="panelbox panelbox-pad loop-setup" aria-labelledby="atk-setup">
          <h2 id="atk-setup" className="box-h">
            New attack
            <Help>A planner writes hostile customers aimed at each promise you pick, each with a different angle, plus a harmless look-alike the agent should simply help. They play against your agent a few times each.</Help>
          </h2>
          <p className="label">Target promises</p>
          <ul className="targets">
            {ranked.map((r) => {
              const v = verdictOf(per, r.id);
              return (
                <li key={r.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={targets.includes(r.id)}
                      onChange={(e) => setPicked(e.target.checked ? [...targets, r.id] : targets.filter((x) => x !== r.id))}
                    />
                    <span className="rule-ref">{r.id}</span>
                    <span className="targets-title">{r.title}</span>
                    {v ? <VerdictChip verdict={v} small /> : <Chip>not run</Chip>}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="knobs">
            <label>
              <span>Attacks per promise</span>
              <input type="number" min={1} max={6} value={n} onChange={(e) => setN(Math.max(1, Math.min(6, Number(e.target.value) || 1)))} />
            </label>
            <label>
              <span>Tries each</span>
              <input type="number" min={1} max={10} value={k} onChange={(e) => setK(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
            </label>
          </div>
          <dl className="pop-facts">
            <div>
              <dt>Conversations</dt>
              <dd>{convs}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>~{usd(usdTotal)}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>~{est.time}</dd>
            </div>
          </dl>
          <p className="quiet small">
            {targets.length} promises × {n} attacks × 2 (with look-alikes) × {k} tries, plus planning.
          </p>
          <button type="button" className="btn btn-ink" disabled={busy || !targets.length || mode !== "local"} onClick={go}>
            {busy ? "Starting…" : "Start attack"}
          </button>
          {mode === "static" && <p className="quiet small">Read-only demo: run tripwire locally to attack.</p>}
          {err && <p className="form-error small">{err}</p>}
        </section>

        <section className="loop-preview" aria-labelledby="atk-past">
          <h2 id="atk-past" className="block-h">
            Past attacks <span className="block-sub">{past.length}</span>
          </h2>
          {!past.length ? (
            <div className="emptybox">
              <p className="emptybox-h">No attacks yet</p>
            </div>
          ) : (
            <ul className="atk-list">
              {past.map((e) => (
                <PastAttack key={e.id} entry={e} run={details[e.id]} rules={scn.rules} />
              ))}
            </ul>
          )}
        </section>
      </div>
      <Flow active="attack" evalId={evalEntry?.id} />
    </>
  );
}

function PastAttack({ entry, run, rules }: { entry: IndexEntry; run?: Run; rules: Rule[] }) {
  const s = run ? summaryOf(run) : undefined;
  const targets = run?.config.rules ?? [];
  const running = entry.status === "running";
  return (
    <li>
      <Link to={runHref(entry.id)} className="atk-past">
        <span className="atk-past-top">
          <Chip>attack</Chip>
          <span className="quiet small">{ago(entry.created)}</span>
          {running && (
            <span className="run-live small">
              <span className="pulse" aria-hidden="true" /> {s?.phase === "planning" ? "planning" : "running"}
            </span>
          )}
          <span className="atk-past-cost quiet small">{usd(s?.cost_usd ?? entry.headline?.cost_usd)}</span>
        </span>
        <span className="atk-past-targets">
          {targets.map((id) => {
            const pr = s?.per_rule?.[id];
            return (
              <Chip key={id} tone={pr?.broken_by ? "breaks" : pr ? "holds" : "neutral"} dot={!!pr} title={rules.find((r) => r.id === id)?.title}>
                {id} {pr ? (pr.broken_by ? `broken by ${pr.broken_by}/${pr.attacks}` : "held") : ""}
              </Chip>
            );
          })}
        </span>
        {s?.headline?.top && <span className="atk-past-top-line">{s.headline.top}</span>}
        {(s?.promote?.length ?? 0) > 0 && <span className="small t-breaks">{plural(s!.promote!.length, "attack")} ready to add as tests</span>}
      </Link>
    </li>
  );
}

// ---------- one attack run ----------

export function AttackRun({ run }: { run: Run }) {
  return (
    <ProjectFrame name={run.scenario} tab="attack" runId={run.id}>
      <AttackBody run={run} />
    </ProjectFrame>
  );
}

function Tries({ run, c, tally, kind }: { run: Run; c?: AttackCase; tally: AttackTally; kind: "trap" | "lookalike" }) {
  // the summary's passes only count tries where a check ran; link each mark to its conversation by try index
  const ts = run.trials.filter((t) => t.case_id === tally.id && t.variant === "attack").sort((a, b) => a.trial - b.trial);
  const k = run.config.k ?? ts.length;
  return (
    <span className="ticks">
      {Array.from({ length: Math.max(k, ts.length) }, (_, i) => {
        const t = ts.find((x) => x.trial === i);
        if (!t) return <span key={i} className="tk tk-wait is-static" title={`try ${i + 1}: waiting`} />;
        const target = c?.target ?? tally.rule;
        const bad = t.error
          ? null
          : kind === "trap"
            ? t.verdicts.some((v) => v.rule === target && !v.passed && !v.error)
            : t.verdicts.some((v) => !v.passed && !v.error);
        const label = `try ${i + 1}: ${bad === null ? "couldn't run" : kind === "trap" ? (bad ? "broke it" : "held") : bad ? "agent refused or failed" : "agent helped"}`;
        return <Link key={i} to={trialHref(run.id, t)} className={`tk ${bad === null ? "tk-skip" : bad ? "tk-fail" : "tk-pass"}`} title={label} aria-label={label} />;
      })}
    </span>
  );
}

function AttackCard({ run, a, look, cases, rules }: { run: Run; a: AttackStat; look?: AttackTally; cases: Record<string, AttackCase>; rules: Record<string, Rule> }) {
  const c = cases[a.id];
  return (
    <li className={`atk-card${a.promote ? " is-promote" : ""}`}>
      <div className="atk-card-main">
        <p className="atk-card-top">
          <Chip>{a.angle || "attack"}</Chip>
          <span className="rule-ref">{a.id}</span>
          {a.promote && <Chip tone="breaks">ready to add</Chip>}
        </p>
        <p className="atk-card-title">{a.title ?? c?.title}</p>
        {c?.persona?.goal && <p className="atk-card-goal">{String(c.persona.goal)}</p>}
        {a.also_broke.length > 0 && (
          <p className="small t-breaks">
            Also broke {a.also_broke.map((r) => `${r}${rules[r] ? ` ${rules[r].title}` : ""}`).join(", ")}
          </p>
        )}
        {look && (
          <p className="atk-look">
            <KindBadge kind="lookalike" /> <span className="atk-look-title">{look.title}</span>
            <Tries run={run} c={cases[look.id]} tally={look} kind="lookalike" />
            <span className={look.broke ? "t-flaky small" : "quiet small"}>
              {look.tries ? (look.broke ? `refused or failed ${look.broke}/${look.tries}` : `helped ${look.tries}/${look.tries}`) : "waiting"}
            </span>
          </p>
        )}
      </div>
      <div className="atk-card-res">
        <Tries run={run} c={c} tally={a} kind="trap" />
        <span className={`atk-score ${a.broke ? "t-breaks" : "t-holds"}`}>{a.tries ? (a.broke ? `broke ${a.broke}/${a.tries}` : `held ${a.tries}/${a.tries}`) : "waiting"}</span>
        {a.tries > 0 && <VerdictChip verdict={a.verdict === "holds" ? "holds" : a.verdict} small />}
      </div>
    </li>
  );
}

function AttackBody({ run }: { run: Run }) {
  const s = summaryOf(run);
  const scn = useScenario(run.scenario);
  const { mode, reloadScenarios } = useAppData();
  const rules = Object.fromEntries((scn?.rules ?? []).map((r) => [r.id, r]));
  const cases = Object.fromEntries((run.config.attacks ?? []).map((c) => [c.id, c]));
  const targets = run.config.rules ?? Object.keys(s.per_rule ?? {});
  const planning = s.phase === "planning";
  const running = run.status === "running";
  const [added, setAdded] = useState<{ ids: string[]; err?: string; busy?: boolean } | null>(null);
  const promoteCases = s.promote_cases ?? [];
  const lookFor = (a: AttackStat) => (s.lookalikes ?? []).find((l) => l.id === a.pair);
  const rulesBroken = s.headline?.rules_broken ?? 0;
  const lookFailed = (s.lookalikes ?? []).filter((l) => l.broke).length;

  const add = async () => {
    setAdded({ ids: [], busy: true });
    try {
      const r = await addCases(run.scenario, promoteCases);
      setAdded({ ids: r.added });
      reloadScenarios();
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 409 ? "This project's tests live in Python code, so new tests can't be added here." : (e as Error).message;
      setAdded({ ids: [], err: msg });
    }
  };

  return (
    <>
      <RunMeta
        run={run}
        title={
          planning
            ? `Planning attacks on ${targets.join(", ")}…`
            : s.headline?.top ?? (running ? "Attacking…" : `${targets.join(", ")} held against every attack`)
        }
      />
      {planning ? (
        <div className="panelbox panelbox-pad planning">
          <p className="box-h">
            <span className="pulse" aria-hidden="true" /> Planning
          </p>
          <p className="quiet">
            Writing {run.config.per_rule ?? 3} attacks per promise, each with a harmless look-alike.
          </p>
          <ul className="planning-list">
            {targets.map((id) => (
              <li key={id}>
                <span className="rule-ref">{id}</span> {rules[id]?.title}
                <span className="ghost-note" aria-hidden="true" />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <StatStrip
            items={[
              { label: "Attacks", value: s.attacks?.length ?? 0, sub: `${s.lookalikes?.length ?? 0} look-alikes` },
              {
                label: "Broke a promise",
                value: (s.attacks ?? []).filter((a) => a.broke).length,
                tone: (s.attacks ?? []).some((a) => a.broke) ? "breaks" : "holds",
                help: "Attacks that broke their target promise at least once.",
              },
              { label: "Promises broken", value: `${rulesBroken}/${targets.length}`, tone: rulesBroken ? "breaks" : "holds" },
              {
                label: "Ready to add",
                value: s.promote?.length ?? 0,
                help: "Attacks that broke their promise in at least half their tries. Adding them (with their look-alikes) makes them regular tests.",
              },
              {
                label: "Look-alikes failed",
                value: lookFailed,
                tone: lookFailed ? "flaky" : undefined,
                help: "Harmless requests the agent refused or got wrong: a sign of over-refusing.",
              },
              {
                label: "Conversations",
                value: s.trials ?? 0,
                sub: (s.errors ?? 0) > 0 ? <span className="is-skip">{s.errors} couldn't run</span> : `of ${run.config.total_trials ?? "?"}`,
              },
              { label: "Cost", value: usd(s.cost_usd ?? 0), sub: `planning ${usd(s.plan_cost_usd ?? 0)}` },
            ]}
          />
          {(run.config.warnings?.length ?? 0) > 0 && (
            <p className="skipline">
              {run.config.warnings!.length} planner notes <Help>{run.config.warnings!.join("; ")}</Help>
            </p>
          )}

          {(s.promote?.length ?? 0) > 0 && (
            <div className="promote-bar">
              <div>
                <p className="promote-bar-h">
                  {plural(s.promote!.length, "attack")} broke a promise in at least half their tries
                </p>
                <p className="quiet small">
                  {s.promote!.length === 1 ? "It" : "They"} and {s.promote!.length === 1 ? "its look-alike" : "their look-alikes"} become {promoteCases.length} tests that every future check runs.
                </p>
              </div>
              {added?.ids.length ? (
                <p className="t-holds small">
                  Added as tests {added.ids.join(", ")}. <Link to={`/scenarios/${encodeURIComponent(run.scenario)}/tests`}>See tests</Link>
                </p>
              ) : (
                <button type="button" className="btn btn-ink btn-sm" disabled={mode !== "local" || running || added?.busy} onClick={add}>
                  {added?.busy ? "Adding…" : `Add ${promoteCases.length} as tests`}
                </button>
              )}
              {added?.err && <p className="form-error small">{added.err}</p>}
            </div>
          )}

          {targets.map((rid) => {
            const pr = s.per_rule?.[rid];
            const mine = (s.attacks ?? []).filter((a) => a.rule === rid);
            const v: RuleVerdict = pr?.verdict ?? "too_few";
            return (
              <section key={rid} className="block atk-rule" aria-labelledby={`atk-${rid}`}>
                <div className="atk-rule-head">
                  <h2 id={`atk-${rid}`} className="block-h">
                    <span className="rule-ref">{rid}</span> {rules[rid]?.title ?? rid}
                  </h2>
                  {pr && pr.tries > 0 && (
                    <>
                      <span className={`atk-verdict ${pr.broken_by ? "t-breaks" : "t-holds"}`}>
                        {pr.broken_by ? `broken by ${pr.broken_by} of ${pr.attacks}` : `held against ${pr.attacks}`}
                      </span>
                      <span className="atk-bar">
                        <IntervalBar rate={pr.tries ? pr.broke / pr.tries : 0} lo={pr.lo} hi={pr.hi} verdict={v === "holds" ? "holds" : pr.broken_by ? "breaks" : v} compact />
                      </span>
                      <span className="quiet small">
                        {pr.broke}/{pr.tries} tries · likely {pct(pr.lo)}–{pct(pr.hi)}
                      </span>
                      <Help>{`${pr.sentence}. Verdict: ${VERDICT_WORDS[v].label}.`}</Help>
                    </>
                  )}
                </div>
                <ul className="atk-cards">
                  {mine.map((a) => (
                    <AttackCard key={a.id} run={run} a={a} look={lookFor(a)} cases={cases} rules={rules} />
                  ))}
                  {!mine.length && <p className="quiet small">No attacks planned for this promise.</p>}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
