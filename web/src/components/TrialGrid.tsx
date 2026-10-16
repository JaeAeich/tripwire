import { Link } from "react-router-dom";
import type { Case, Trial } from "../lib/types";
import { trialHref } from "../lib/routes";
import { KindBadge } from "./promise";

/** One test per row; each try is a small mark. Red broke a promise, grey couldn't run (not counted). */
export function TrialGrid({
  runId,
  trials,
  caseIds,
  cases,
  k,
  variant = "base",
}: {
  runId: string;
  trials: Trial[];
  caseIds: string[];
  cases: Record<string, Case>;
  k: number;
  variant?: string;
}) {
  const mine = trials.filter((t) => t.variant === variant);
  return (
    <ol className="trial-grid">
      {caseIds.map((cid) => {
        const ts = mine.filter((t) => t.case_id === cid).sort((a, b) => a.trial - b.trial);
        const c = cases[cid];
        const ran = ts.filter((t) => !t.error);
        const passed = ran.filter((t) => t.passed).length;
        const slots = Math.max(k, ts.length);
        return (
          <li key={cid} className="trial-row">
            <div className="trial-case">
              <p className="case-title">
                <KindBadge kind={c?.kind} /> {c?.title ?? `Test ${cid}`}
              </p>
              {c?.why && <p className="case-why">{c.why}</p>}
            </div>
            <div className="ticks" role="list" aria-label={`Tries of test ${cid}`}>
              {Array.from({ length: slots }, (_, i) => {
                const t = ts.find((x) => x.trial === i);
                if (!t)
                  return (
                    <span key={i} role="listitem" className="tk tk-wait" title={`Try ${i + 1}: waiting`}>
                      <span className="sr">Try {i + 1} waiting</span>
                    </span>
                  );
                const skip = !!t.error;
                const failed = !skip && !t.passed;
                const rules = [...new Set(t.verdicts.filter((v) => !v.passed && !v.error).map((v) => v.rule))];
                const label = `Try ${i + 1}: ${skip ? "couldn't run, not counted" : failed ? `broke ${rules.join(", ") || "a promise"}` : "kept every promise"}`;
                return (
                  <Link
                    key={i}
                    role="listitem"
                    to={trialHref(runId, t)}
                    className={`tk ${skip ? "tk-skip" : failed ? "tk-fail" : "tk-pass"}`}
                    title={label}
                    aria-label={label}
                  />
                );
              })}
            </div>
            <div className="trial-rate">
              {ran.length ? (
                <span className={passed < ran.length ? "is-bad" : ""}>
                  {passed} of {ran.length} passed
                </span>
              ) : (
                <span className="quiet">{ts.length ? "couldn't run" : "waiting"}</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
