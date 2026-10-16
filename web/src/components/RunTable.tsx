// Run history as a table: when, what, result, pass rate with range, conversations, cost, models.
import { Link, useNavigate } from "react-router-dom";
import { topSentence } from "../lib/attribution";
import { useAppData } from "../lib/context";
import { displayName } from "../lib/draft";
import { ago, cut, pct, stamp, usd } from "../lib/format";
import { useRuns } from "../lib/projects";
import { runHref, scenarioHref } from "../lib/routes";
import type { AttackSummary, AttributionSummary, EvalSummary, IndexEntry } from "../lib/types";
import { silentFor, STALE_S } from "./LivePanel";
import { shortModel } from "./RunHead";
import { StatusTag } from "./bits";
import { verdictCounts, VerdictBar } from "./Stats";
import { Chip } from "./Chip";

export function RunTable({ runs, showProject = true, limit }: { runs: IndexEntry[]; showProject?: boolean; limit?: number }) {
  const shown = limit ? runs.slice(0, limit) : runs;
  const details = useRuns(shown.slice(0, 30));
  const { scenarios } = useAppData();
  const nav = useNavigate();
  const now = Date.now();
  if (!shown.length) return <p className="empty">No runs yet.</p>;
  return (
    <div className="table-wrap">
      <table className="rtable">
        <thead>
          <tr>
            <th>When</th>
            {showProject && <th>Project</th>}
            <th>Kind</th>
            <th>Result</th>
            <th className="num">Pass rate</th>
            <th className="num">Conversations</th>
            <th className="num">Cost</th>
            <th className="hide-sm">Models</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const run = details[r.id];
            const scn = scenarios.find((s) => s.name === r.scenario);
            const s = run?.summary as (Partial<EvalSummary> & Partial<AttributionSummary>) | undefined;
            const isEval = r.kind === "eval";
            const running = r.status === "running";
            const stale = running && silentFor(r, now) > STALE_S;
            const ids = scn?.rules.map((x) => x.id) ?? Object.keys(s?.per_rule ?? {});
            const c = s?.per_rule ? verdictCounts(s.per_rule, ids) : null;
            const ran = run ? run.trials.filter((t) => t.variant === "base" && !t.error).length : r.headline?.trials ?? 0;
            const total = r.config?.total_trials;
            const errors = run ? run.trials.filter((t) => t.error).length : 0;
            const m = r.config?.models;
            const atk = r.kind === "attack" ? (run?.summary as unknown as Partial<AttackSummary> | undefined) : undefined;
            const top = atk
              ? atk.phase === "planning"
                ? "Planning attacks…"
                : atk.headline?.top ?? `Held against ${atk.attacks?.length ?? 0} attacks on ${(run?.config.rules ?? []).join(", ")}`
              : !isEval
                ? topSentence(r.headline?.top !== undefined ? { headline: { culprits: 0, load_bearing: 0, top: r.headline.top ?? null } } : s)
                : null;
            return (
              <tr key={r.id} onClick={() => nav(runHref(r.id))} className={running && !stale ? "is-running" : ""}>
                <td className="when" title={stamp(r.created)}>
                  <Link to={runHref(r.id)} onClick={(e) => e.stopPropagation()}>
                    {ago(r.created, now)}
                  </Link>
                  {r.config?.label && <span className="cell-sub run-label-cell">{r.config.label}</span>}
                </td>
                {showProject && (
                  <td>
                    <Link to={scenarioHref(r.scenario)} onClick={(e) => e.stopPropagation()} className="plain-link">
                      {displayName(scenarios.find((s) => s.name === r.scenario), r.scenario)}
                    </Link>
                  </td>
                )}
                <td>
                  <Chip>{isEval ? "check" : r.kind === "attribute" ? "map" : r.kind}</Chip>
                </td>
                <td className="result">
                  {running && !stale ? (
                    <span className="run-live">
                      <span className="pulse" aria-hidden="true" /> {run?.trials.length ?? 0}/{total ?? "?"} running
                    </span>
                  ) : r.status !== "done" && r.status !== "stopped" ? (
                    <StatusTag status={r.status} stale={stale} />
                  ) : isEval && c ? (
                    <span className="result-v">
                      <VerdictBar c={c} />
                      <span className="result-words">
                        {c.holds} hold
                        {c.breaks ? <span className="t-breaks"> · {c.breaks} break</span> : null}
                        {c.flaky ? <span className="t-flaky"> · {c.flaky} flaky</span> : null}
                        {c.too_few ? <span className="t-few"> · {c.too_few} not sure</span> : null}
                      </span>
                    </span>
                  ) : !isEval ? (
                    <span className="result-words" title={top ?? undefined}>
                      {top ? cut(top, 70) : "No clear cause"}
                    </span>
                  ) : (
                    <span className="quiet">…</span>
                  )}
                  {r.status === "stopped" && <span className="quiet small"> (stopped)</span>}
                </td>
                <td className="num">
                  {isEval ? (
                    <>
                      {pct(r.headline?.pass_at_1)}
                      {s?.pass_at_1_ci && (
                        <span className="cell-sub">
                          {pct(s.pass_at_1_ci[0])}–{pct(s.pass_at_1_ci[1])}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="quiet">–</span>
                  )}
                </td>
                <td className="num">
                  {isEval ? ran : run?.trials.length ?? r.headline?.trials ?? 0}
                  {total ? <span className="quiet">/{total}</span> : null}
                  {errors > 0 && <span className="cell-sub is-skip">{errors} couldn't run</span>}
                </td>
                <td className="num">{usd(r.headline?.cost_usd ?? s?.cost_usd)}</td>
                <td className="hide-sm models">{m ? `${shortModel(m.agent)} / ${shortModel(m.user)} / ${shortModel(m.judge)}` : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
