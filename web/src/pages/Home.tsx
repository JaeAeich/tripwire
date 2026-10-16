// The workspace: projects with their latest status, what's running now, and recent runs.
import { Link } from "react-router-dom";
import { DEV_FIXTURES, MOCK } from "../lib/api";
import { useAppData } from "../lib/context";
import { displayName } from "../lib/draft";
import { ago, dur, pct, usd } from "../lib/format";
import { useAsync, useDocumentTitle, useNow } from "../lib/hooks";
import { useRuns } from "../lib/projects";
import { runHref, scenarioHref } from "../lib/routes";
import type { IndexEntry, Run, Scenario } from "../lib/types";
import { ErrorNote, Loading } from "../components/bits";
import { StatusDot } from "../components/Layout";
import { RunTable } from "../components/RunTable";
import { Help, verdictCounts, VerdictBar } from "../components/Stats";
import { Chip } from "../components/Chip";
import { perRuleOf, useHistory } from "../lib/history";
import { compareRuns as compareApi } from "../lib/api";
import { Sparkline } from "./Project";

function LiveCard({ entry, run }: { entry: IndexEntry; run?: Run }) {
  const now = useNow(1000);
  const done = run?.trials.length ?? entry.headline?.trials ?? 0;
  const total = entry.config?.total_trials ?? 0;
  return (
    <Link to={runHref(entry.id)} className="livecard">
      <span className="livecard-top">
        <span className="pulse" aria-hidden="true" />
        <b>{entry.scenario}</b>
        <span className="quiet">{entry.kind === "eval" ? "check" : "map"}</span>
        <span className="quiet livecard-t">{dur(now / 1000 - entry.created)}</span>
      </span>
      <span className="livecard-track">
        <span style={{ width: `${total ? Math.max(3, (done / total) * 100) : 3}%` }} />
      </span>
      <span className="livecard-nums">
        {done}/{total || "?"} conversations · {usd(run?.summary.cost_usd ?? 0)}
      </span>
    </Link>
  );
}

function ProjectRow({ scn }: { scn: Scenario }) {
  const h = useHistory(scn.name, scn.sections);
  const latest = h.evals[h.evals.length - 1];
  const prev = h.evals[h.evals.length - 2];
  const ids = scn.rules.map((r) => r.id);
  const c = latest ? verdictCounts(perRuleOf(latest), ids) : null;
  const cmp = useAsync(() => (latest && prev ? compareApi(prev.id, latest.id) : Promise.resolve(null)), [latest?.id, prev?.id]);
  const cc = cmp.data ? { fixed: cmp.data.fixed.length, regressed: cmp.data.regressed.length } : null;
  const last = h.entries[0];
  return (
    <li>
      <Link to={scenarioHref(scn.name)} className="prow">
        <span className="prow-name">
          <StatusDot entry={h.entries.find((e) => e.kind === "eval")} />
          <span className="prow-title">{displayName(scn)}</span>
        </span>
        <span className="prow-desc">{scn.description}</span>
        <span className="prow-health">
          {c ? (
            <>
              <VerdictBar c={c} />
              <span className="prow-counts">
                {c.breaks > 0 && <span className="t-breaks">{c.breaks} break</span>}
                {c.flaky > 0 && <span className="t-flaky">{c.flaky} flaky</span>}
                {c.too_few > 0 && <span>{c.too_few} not sure</span>}
                {!c.breaks && !c.flaky && !c.too_few && <span className="t-holds">all hold</span>}
              </span>
            </>
          ) : (
            <span className="quiet small">{h.running ? "first check running" : "not checked yet"}</span>
          )}
        </span>
        <span className="prow-trend">
          <Sparkline values={h.evals.slice(-8).map((r) => r.summary.pass_at_1 ?? 0)} />
          <span className="num">{latest ? pct(latest.summary.pass_at_1) : ""}</span>
        </span>
        <span className="prow-change">
          {cc && (cc.fixed || cc.regressed) ? (
            <>
              {cc.fixed > 0 && <Chip tone="holds">+{cc.fixed}</Chip>}
              {cc.regressed > 0 && <Chip tone="breaks">−{cc.regressed}</Chip>}
            </>
          ) : cc ? (
            <span className="quiet small">no change</span>
          ) : null}
        </span>
        <span className="prow-when">
          {h.running ? (
            <span className="run-live">
              <span className="pulse" aria-hidden="true" /> running
            </span>
          ) : last ? (
            ago(last.created)
          ) : (
            "–"
          )}
        </span>
      </Link>
    </li>
  );
}

export function Home() {
  useDocumentTitle("Workspace");
  const { scenarios, scenariosError, runs, runsError } = useAppData();
  const live = (runs ?? []).filter((r) => r.status === "running");
  const liveRuns = useRuns(live);
  const latestOf = (name: string) => (runs ?? []).find((r) => r.kind === "eval" && r.scenario === name && r.status !== "running");
  // projects that need attention first: lowest pass rate of the latest check, then most recent
  const projects = [...scenarios].sort((a, b) => (latestOf(a.name)?.headline?.pass_at_1 ?? 2) - (latestOf(b.name)?.headline?.pass_at_1 ?? 2));

  return (
    <div className="view">
      <header className="vhead">
        <div>
          <h1 className="vhead-title">Workspace</h1>
        </div>
        <div className="vhead-actions">
          <Link to="/check" className="btn btn-ink">
            New project
          </Link>
        </div>
      </header>

      {scenariosError && <ErrorNote error={scenariosError} what="projects" />}
      {!scenarios.length && !scenariosError ? (
        <section className="block block-first">
          <div className="welcome panelbox">
            <h2 className="welcome-h">Check what your agent's prompt really does</h2>
            <ol className="welcome-steps">
              <li>
                <b>Paste the prompt</b>
                <span>We draft the promises it makes and test conversations for each.</span>
              </li>
              <li>
                <b>Review</b>
                <span>Fix what we got wrong. Nothing runs until you say so.</span>
              </li>
              <li>
                <b>Run the check</b>
                <span>Every promise gets a verdict; failures open at the step that broke.</span>
              </li>
            </ol>
            <div className="form-actions">
              <Link to="/check" className="btn btn-ink">
                New project
              </Link>
              <Link to="/check?example=1" className="btn btn-line">
                Start from an example
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <>
          {live.length > 0 && (
            <section className="block block-first" aria-labelledby="live">
              <h2 id="live" className="block-h">
                Running now
              </h2>
              <div className="livecards">
                {live.map((r) => (
                  <LiveCard key={r.id} entry={r} run={liveRuns[r.id]} />
                ))}
              </div>
            </section>
          )}
          <section className={`block${live.length ? "" : " block-first"}`} aria-labelledby="projects">
            <h2 id="projects" className="block-h">
              Projects <span className="block-sub">{scenarios.length}</span>
              <Help>Ordered by the latest check's pass rate, worst first. The line is the pass rate over the last checks; +n / −n are promises that got better or worse since the check before.</Help>
            </h2>
            <ul className="plist panelbox">
              {projects.map((s) => (
                <ProjectRow key={s.name} scn={s} />
              ))}
            </ul>
          </section>
        </>
      )}

      {(runs?.length ?? 0) > 0 && (
        <section className="block" aria-labelledby="recent">
          <h2 id="recent" className="block-h">
            Recent activity
            {(runs?.length ?? 0) > 6 && (
              <Link to="/runs" className="block-link">
                All {runs?.length}
              </Link>
            )}
          </h2>
          {runsError && <ErrorNote error={runsError} what="runs" />}
          {!runs && !runsError ? <Loading what="runs" /> : <RunTable runs={runs ?? []} limit={6} />}
          {DEV_FIXTURES.length > 0 && !MOCK && (
            <p className="quiet small dev-note">
              Dev fixture (fictional):{" "}
              {DEV_FIXTURES.map((id) => (
                <Link key={id} to={runHref(id)}>
                  {id}
                </Link>
              ))}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

export function RunsIndex() {
  useDocumentTitle("All runs");
  const { runs, runsError } = useAppData();
  const spent = (runs ?? []).reduce((s, r) => s + (r.headline?.cost_usd ?? 0), 0);
  return (
    <div className="view">
      <header className="vhead">
        <div>
          <p className="crumbs">
            <Link to="/">Workspace</Link>
          </p>
          <h1 className="vhead-title">All runs</h1>
          <p className="vhead-facts">
            <span>{runs?.length ?? "…"} runs</span>
            <span>{usd(spent)} spent</span>
          </p>
        </div>
      </header>
      {runsError && <ErrorNote error={runsError} what="runs" />}
      {!runs && !runsError ? <Loading what="runs" /> : <RunTable runs={runs ?? []} />}
    </div>
  );
}
