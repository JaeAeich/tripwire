// Project tabs: Tests, Runs, Map. (Overview, Prompt, promise and test pages live in Project.tsx.)
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getRun } from "../lib/api";
import { asDraftCase, displayName, newCaseFor } from "../lib/draft";
import { useEditing } from "../lib/edit";
import { useAppData, useScenario } from "../lib/context";
import { useAsync, useDocumentTitle } from "../lib/hooks";
import { runTally, useRuns } from "../lib/projects";
import { runHref, scenarioHref, trialHref } from "../lib/routes";
import type { Case, CaseKind, EvalSummary, IndexEntry, Scenario, Trial } from "../lib/types";
import { tallyWords } from "../lib/words";
import { ErrorNote, Loading } from "../components/bits";
import { ProjectFrame, projectRuns } from "../components/ProjectFrame";
import { KindBadge } from "../components/promise";
import { TestRow } from "../components/TestEditor";
import { SetupSections } from "../components/Setup";
import { useSaving } from "../components/Editable";
import { Chip } from "../components/Chip";
import { RunTable } from "../components/RunTable";
import { ScoreChart } from "../components/ScoreChart";
import { Help } from "../components/Stats";
import { MapBody } from "./AttributionRun";

export function ScenariosIndex() {
  useDocumentTitle("Projects");
  const { scenarios } = useAppData();
  return (
    <div className="view">
      <header className="vhead">
        <div>
          <h1 className="vhead-title">Projects</h1>
        </div>
      </header>
      <ul className="plist">
        {scenarios.map((s) => (
          <li key={s.name}>
            <Link to={scenarioHref(s.name)}>{displayName(s)}</Link> <span className="quiet">{s.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function useLatestEval(name: string) {
  const { runs } = useAppData();
  const evals = projectRuns(runs, name).filter((r) => r.kind === "eval");
  const entry = evals.find((e) => e.status !== "running") ?? evals[0];
  const details = useRuns(entry ? [entry] : []);
  return { entry, run: entry ? details[entry.id] : undefined, evals };
}

// ---------- Tests ----------

export function ProjectTests() {
  const { name = "" } = useParams();
  useDocumentTitle(`${name} tests`);
  return (
    <ProjectFrame name={name} tab="tests">
      <TestsTab name={name} />
    </ProjectFrame>
  );
}

const KINDS: (CaseKind | "all")[] = ["all", "plain", "trap", "lookalike"];

function TestsTab({ name }: { name: string }) {
  const scn = useScenario(name);
  const editing = useEditing();
  const { entry, run } = useLatestEval(name);
  const [kind, setKind] = useState<CaseKind | "all">("all");
  const [fresh, setFresh] = useState<string | null>(null);
  const adding = useSaving();
  if (!scn) return <Loading what="tests" />;
  const draftCases = editing.draft?.cases;
  const cases = scn.cases.filter((c) => kind === "all" || c.kind === kind);
  const rulesList = editing.draft?.rules ?? scn.rules;
  const tools = editing.draft?.tools ?? [];
  const edited = (c: Case) => {
    const then = run?.config.case_hashes?.[c.id];
    return !!then && !!c.hash && then !== c.hash;
  };
  const addTest = () =>
    adding.run(async () => {
      let id = "";
      await editing.update((d) => {
        const c = newCaseFor(d.rules[0], d.cases);
        id = c.id;
        return { ...d, cases: [...d.cases, c] };
      });
      setKind("all");
      setFresh(id);
    });
  const count = (k: CaseKind) => scn.cases.filter((c) => c.kind === k).length;
  const tries = (c: Case): Trial[] => (run?.trials ?? []).filter((t) => t.variant === "base" && t.case_id === c.id).sort((a, b) => a.trial - b.trial);
  return (
    <>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Kind">
          {KINDS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "is-on" : ""} onClick={() => setKind(k)}>
              {k === "all" ? `All ${scn.cases.length}` : `${k === "lookalike" ? "Look-alike" : k[0].toUpperCase() + k.slice(1)} ${count(k)}`}
            </button>
          ))}
        </div>
        <p className="quiet small">
          {entry ? (
            <>
              Marks: tries in the <Link to={runHref(entry.id)}>latest check</Link>
            </>
          ) : (
            "Not run yet"
          )}
        </p>
      </div>
      <div className="panelbox">
        <ul className="tcases">
          {cases.map((c) => {
            const ts = tries(c);
            const refs = [...new Set((c.checks ?? []).map((x) => x.rule))];
            return (
              <TestRow
                key={c.id}
                c={draftCases?.find((x) => x.id === c.id) ?? asDraftCase(c)}
                rules={rulesList}
                tools={tools}
                startOpen={fresh === c.id}
                extra={
                  <span className="tcase-extra">
                    {edited(c) && <Chip title="Changed after the latest check ran: its marks are for the old version">edited since</Chip>}
                    <span className="tcase-refs">{refs.join(" ")}</span>
                    <span className="ticks">
                      {ts.map((t) => (
                        <Link
                          key={t.trial}
                          to={trialHref(entry!.id, t)}
                          className={`tk ${t.error ? "tk-skip" : t.passed ? "tk-pass" : "tk-fail"}`}
                          title={`try ${t.trial + 1}: ${t.error ? "couldn't run" : t.passed ? "passed" : "broke a promise"}`}
                        />
                      ))}
                    </span>
                  </span>
                }
              />
            );
          })}
        </ul>
        {editing.editable && (
          <p className="tcases-add">
            <button type="button" className="add-note add-test" onClick={addTest} disabled={adding.busy || !rulesList.length}>
              + Add a test
            </button>
            {adding.mark}
          </p>
        )}
      </div>
      <p className="legend-row small quiet">
        <KindBadge kind="plain" /> ordinary customer <KindBadge kind="trap" /> pushes to break a promise <KindBadge kind="lookalike" /> looks like a trap,
        isn't
      </p>
      <p className="small quiet">
        The tools the agent can call, the simulated world and the models are in <Link to={`${scenarioHref(name)}/setup`}>Setup</Link>.
      </p>
    </>
  );
}

// ---------- Setup ----------

export function ProjectSetup() {
  const { name = "" } = useParams();
  useDocumentTitle(`${name} setup`);
  return (
    <ProjectFrame name={name} tab="setup">
      <SetupSections />
    </ProjectFrame>
  );
}

// ---------- Runs ----------

export function ProjectRuns() {
  const { name = "" } = useParams();
  useDocumentTitle(`${name} runs`);
  return (
    <ProjectFrame name={name} tab="runs">
      <RunsTab name={name} />
    </ProjectFrame>
  );
}

function RunsTab({ name }: { name: string }) {
  const { runs } = useAppData();
  const scn = useScenario(name);
  const mine = projectRuns(runs, name);
  const evals = mine.filter((e) => e.kind === "eval" && e.status !== "running" && (e.headline?.trials ?? 1) > 0);
  const details = useRuns(evals);
  const points = [...evals].reverse().map((e) => {
    const run = details[e.id];
    const s = run?.summary as Partial<EvalSummary> | undefined;
    const t = runTally(run, scn as Scenario | undefined);
    return { id: e.id, created: e.created, value: e.headline?.pass_at_1 ?? 0, lo: s?.pass_at_1_ci?.[0], hi: s?.pass_at_1_ci?.[1], note: t ? tallyWords(t) : "" };
  });
  return (
    <>
      {points.length > 1 && (
        <section className="panelbox panelbox-pad chartbox" aria-label="Pass rate over time">
          <p className="box-h">Pass rate over time</p>
          <ScoreChart points={points} label={`Pass rate of ${name} over ${points.length} checks`} />
        </section>
      )}
      <RunTable runs={mine} showProject={false} />
    </>
  );
}

// ---------- Map ----------

export function ProjectMap() {
  const { name = "" } = useParams();
  useDocumentTitle(`${name} map`);
  const { runs } = useAppData();
  const mine = projectRuns(runs, name);
  const latest: IndexEntry | undefined = mine.find((r) => r.kind === "attribute" && r.status === "done") ?? mine.find((r) => r.kind === "attribute");
  const run = useAsync(() => (latest ? getRun(latest.id) : Promise.resolve(null)), [latest?.id, latest?.updated]);
  const evalEntry = mine.find((r) => r.kind === "eval" && r.status !== "running");
  return (
    <ProjectFrame name={name} tab="map" runId={latest?.id}>
      {!runs ? (
        <Loading what="map" />
      ) : !latest ? (
        <div className="emptybox">
          <p className="emptybox-h">
            No map yet <Help>The map takes out one part of the prompt at a time and replays the failing tests: it shows which part holds each promise up and which part makes it break.</Help>
          </p>
          {evalEntry ? (
            <Link to={`${runHref(evalEntry.id)}?find=1`} className="btn btn-ink btn-sm">
              Draw the map from the latest check
            </Link>
          ) : (
            <p className="quiet small">Run a check first.</p>
          )}
        </div>
      ) : run.error ? (
        <ErrorNote error={run.error} what="map" />
      ) : !run.data ? (
        <Loading what="map" />
      ) : (
        <MapBody run={run.data} />
      )}
    </ProjectFrame>
  );
}
