import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { labelRun } from "../lib/api";
import { useAppData } from "../lib/context";
import { stamp } from "../lib/format";
import { useState } from "react";
import { Editable } from "./Editable";
import { runHref } from "../lib/routes";
import type { Run } from "../lib/types";
import { StatusTag } from "./bits";
import { Chip } from "./Chip";
import { RunBar, silentFor, STALE_S } from "./LivePanel";
import { Help } from "./Stats";

export function shortModel(m: string) {
  return m.replace(/^claude-/, "").replace(/-\d.*$/, "");
}

/** A run's own short name ("after refund rewrite"), edited in place. Free: it only touches run.json. */
export function RunLabel({ run }: { run: Run }) {
  const { mode, reloadRuns } = useAppData();
  const [label, setLabel] = useState(run.config.label ?? "");
  const canEdit = mode === "local" && run.status !== "running";
  if (!canEdit && !label) return null;
  return (
    <span className="run-label">
      <Editable
        value={label}
        label="run label"
        placeholder="Add a label"
        allowEmpty
        readOnly={!canEdit}
        onSave={async (v) => {
          const r = await labelRun(run.id, v);
          setLabel(r.label);
          reloadRuns();
        }}
      />
    </span>
  );
}

/** One line of facts about a run (inside a project page), plus the live bar while it runs. No banners: anything
 * worth explaining sits behind a "?". */
export function RunMeta({ run, title, actions }: { run: Run; title: ReactNode; actions?: ReactNode }) {
  const m = run.config.models;
  const fixture = (run.config as Record<string, unknown>).fixture_note as string | undefined;
  const of = run.config.total_trials ? ` of ${run.config.total_trials}` : "";
  return (
    <>
      {run.status === "running" && <RunBar run={run} what={run.kind === "eval" ? "Check running" : run.kind === "attack" ? "Attack running" : "Map being drawn"} />}
      <div className="runmeta">
        <div className="runmeta-main">
          <h2 className="runmeta-title">{title}</h2>
          <p className="runmeta-facts">
            <RunLabel run={run} />
            <StatusTag status={run.status} stale={run.status === "running" && silentFor(run) > STALE_S} />
            {run.status === "stopped" && <Help>{`Stopped by hand after ${run.trials.length}${of} conversations. Results cover only those.`}</Help>}
            {run.status === "failed" && <Help>{`Crashed after ${run.trials.length}${of} conversations: ${run.summary.error ?? "no error message"}`}</Help>}
            {fixture && (
              <Chip tone="flaky" title={fixture}>
                fictional data
              </Chip>
            )}
            {typeof run.config.note === "string" && run.config.note && <Chip title={run.config.note}>note</Chip>}
            <span className="num">{stamp(run.created)}</span>
            {run.config.k && <span>{run.config.k} tries per test</span>}
            {m && (
              <span title={`agent ${m.agent} · simulated customer ${m.user} · reviewer ${m.judge}`}>
                agent <b>{shortModel(m.agent)}</b> · customer <b>{shortModel(m.user)}</b> · reviewer <b>{shortModel(m.judge)}</b>
              </span>
            )}
            {run.kind === "eval" && run.config.judge === false && <span>reviewer off</span>}
            {run.config.base_run && (
              <span>
                from <Link to={runHref(run.config.base_run)}>this check</Link>
              </span>
            )}
            <span className="mono quiet">{run.id}</span>
          </p>
        </div>
        {actions && <div className="runmeta-actions">{actions}</div>}
      </div>
    </>
  );
}
