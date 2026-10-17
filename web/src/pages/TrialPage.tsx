// One conversation, read like a script, with the checks in the margin.
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useRules, useScenario } from "../lib/context";
import { secs, usd, variantLabel } from "../lib/format";
import { useDocumentTitle, usePrefersReducedMotion, useRun } from "../lib/hooks";
import { runHref, trialHref } from "../lib/routes";
import type { Case, Trial } from "../lib/types";
import { DocHead, ErrorNote, Loading } from "../components/bits";
import { Help } from "../components/Stats";
import { ProjectFrame } from "../components/ProjectFrame";
import { KindBadge } from "../components/promise";
import { StateDiff, Transcript, VerdictList } from "../components/Transcript";

export function CaseSetup({ c }: { c: Case }) {
  return (
    <details className="case-setup">
      <summary>Who the customer is</summary>
      {c.why && <p className="case-why">{c.why}</p>}
      {c.persona && (
        <dl className="persona">
          {Object.entries(c.persona).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {c.script && (
        <ol className="script">
          {c.script.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}
    </details>
  );
}

export function TrialPage() {
  const { id, variant, caseId, n } = useParams();
  const run = useRun(id);
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const reduced = usePrefersReducedMotion();
  const stepParam = params.get("step");
  const activeStep = stepParam === null ? null : Number(stepParam);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const scn = useScenario(run.data?.scenario);
  const rules = useRules(run.data?.scenario);
  useDocumentTitle(`test ${caseId} try ${Number(n) + 1}`);

  const siblings: Trial[] = useMemo(() => (run.data?.trials ?? []).filter((t) => t.variant === variant), [run.data, variant]);
  const trial = siblings.find((t) => t.case_id === caseId && String(t.trial) === n);
  const idx = trial ? siblings.indexOf(trial) : -1;
  const failedSiblings = siblings.filter((t) => !t.passed && !t.error);
  const nextFail = trial ? failedSiblings.find((t) => siblings.indexOf(t) > idx) ?? failedSiblings[0] : undefined;

  const onJump = useCallback(
    (step: number) => {
      setFocusPath(null);
      setParams({ step: String(step) }, { replace: true });
    },
    [setParams],
  );
  const onShowState = useCallback(
    (path: string | null) => {
      setFocusPath(path);
      if (!path) return;
      const el =
        document.getElementById(`state-${path}`) ??
        [...document.querySelectorAll<HTMLElement>(".diff-entry")].find((e) => e.id.startsWith(`state-${path}`));
      el?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      el?.focus({ preventScroll: true });
    },
    [reduced],
  );

  if (run.error && !run.data) return <div className="page"><ErrorNote error={run.error} what="run" /></div>;
  if (!run.data) return <div className="page"><Loading what="conversation" /></div>;
  if (!trial)
    return (
      <div className="page">
        <p className="quiet">
          This conversation is not in the run{run.data.status === "running" ? " yet; it is still running" : ""}.{" "}
          <Link to={runHref(run.data.id)}>Back to the report</Link>
        </p>
      </div>
    );

  const c = scn?.cases.find((x) => x.id === trial.case_id) ?? (run.data.config.attacks?.find((x) => x.id === trial.case_id) as unknown as Case | undefined);
  const failedRules = [...new Set(trial.verdicts.filter((v) => !v.passed && !v.error).map((v) => v.rule))];
  const prev = siblings[idx - 1];
  const next = siblings[idx + 1];
  const isMap = run.data.kind === "attribute";

  return (
    <ProjectFrame name={run.data.scenario} tab={isMap ? "map" : "runs"} runId={run.data.id}>
      <DocHead
        crumbs={[
          { to: runHref(run.data.id), label: isMap ? "← Map" : "← Report" },
          { label: `test ${trial.case_id}, try ${trial.trial + 1}` },
        ]}
        title={
          <>
            {c?.title ?? `Test ${trial.case_id}`} <KindBadge kind={c?.kind} />
          </>
        }
        sub={
          <p className={`verdict-lead ${trial.error ? "is-quiet" : trial.passed ? "is-good" : "is-bad"}`}>
            {trial.error ? (
              <>
                Couldn't run, so it isn't counted <Help>{`A problem on our side, not the agent's: ${trial.error}`}</Help>
              </>
            ) : trial.passed ? (
              <>Kept every promise it checks.</>
            ) : (
              <>
                Broke{" "}
                {failedRules.map((r, i) => (
                  <span key={r}>
                    <b>{r}</b> {rules[r]?.title ?? ""}
                    {i < failedRules.length - 1 ? ", " : ""}
                  </span>
                ))}
                .
              </>
            )}
          </p>
        }
        meta={[
          trial.variant !== "base" ? <span className="is-accent">{variantLabel(trial.variant)}</span> : null,
          `${trial.turns.length} step${trial.turns.length === 1 ? "" : "s"}`,
          secs(trial.latency_s),
          usd(trial.cost_usd),
          (trial.retries ?? 0) > 0 ? <span title="The whole conversation was rerun after an infrastructure error.">rerun {trial.retries}× after an error</span> : null,
          (trial.protocol_retries ?? 0) > 0 ? (
            <span title="Model steps redone because the model called a tool the wrong way. Harmless: the bad step is thrown away.">
              {trial.protocol_retries} step{trial.protocol_retries === 1 ? "" : "s"} redone
            </span>
          ) : null,
        ]}
        actions={
          <nav className="pager" aria-label="Other conversations">
            {prev ? <Link to={trialHref(run.data.id, prev)}>← Previous</Link> : <span className="quiet">← Previous</span>}
            {next ? <Link to={trialHref(run.data.id, next)}>Next →</Link> : <span className="quiet">Next →</span>}
            {nextFail && nextFail !== trial && (
              <button type="button" className="btn btn-line btn-sm" onClick={() => nav(trialHref(run.data!.id, nextFail))}>
                Next failure
              </button>
            )}
          </nav>
        }
      >
      </DocHead>

      <div className="trial-layout">
        <article className="sheet trial-main" aria-label="Transcript">
          {c && <CaseSetup c={c} />}
          <Transcript trial={trial} activeStep={activeStep} />
        </article>
        <aside className="trial-aside" aria-label="Checks and final state">
          <p className="label">{trial.passed || trial.error ? "Checks" : "Why it failed"}</p>
          <VerdictList verdicts={trial.verdicts} rules={rules} onJump={onJump} onShowState={onShowState} />
          <p className="label">What changed in the data</p>
          <StateDiff diff={trial.state_diff} verdicts={trial.verdicts} focusPath={focusPath} />
        </aside>
      </div>
    </ProjectFrame>
  );
}
