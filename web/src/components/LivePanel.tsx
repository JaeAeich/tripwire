import { useState } from "react";
import { stopRun } from "../lib/api";
import { useAppData, useScenario } from "../lib/context";
import { cut, dur, json, PHASE_WORDS, plural, usd, variantLabel } from "../lib/format";
import { useNow } from "../lib/hooks";
import type { LiveTrial, Run, Turn } from "../lib/types";

const WORKERS = 4; // server default; only used for a rough ETA
export const STALE_S = 90;

/** Seconds since the run last wrote anything (old runs without `updated` fall back to `created`). */
export function silentFor(run: { updated?: number; created: number }, now = Date.now()): number {
  return now / 1000 - (run.updated || run.created);
}

function LiveTurn({ turn }: { turn: Turn }) {
  if (turn.tool_call) {
    const c = turn.tool_call;
    return (
      <li className="lt lt-tool">
        <span className="lt-who">tool</span>
        <code className="lt-text">
          {c.name}({cut(Object.entries(c.args ?? {}).map(([k, v]) => `${k}=${json(v)}`).join(", "), 60)}) → {cut(json(c.result), 70)}
          {c.blocked && <span className="is-bad"> blocked</span>}
        </code>
      </li>
    );
  }
  return (
    <li className={`lt lt-${turn.role}`}>
      <span className="lt-who">{turn.role === "user" ? "customer" : turn.role}</span>
      <span className="lt-text">{cut(turn.text ?? "", 200)}</span>
    </li>
  );
}

function LiveCard({ t, title, now }: { t: LiveTrial; title?: string; now: number }) {
  const last = (t.turns ?? []).slice(-3);
  const hidden = (t.turns ?? []).length - last.length;
  return (
    <li className="live-card">
      <p className="live-card-title">
        {title ?? `Test ${t.case_id}`} <span className="quiet">· try {t.trial + 1}</span>
        <span className="quiet live-card-t">{dur(now / 1000 - t.started)}</span>
      </p>
      <p className="live-card-sub">
        {t.variant !== "base" && <span>{variantLabel(t.variant)} · </span>}
        {t.attempt > 0 && <span className="is-bad">retry {t.attempt} · </span>}
        <span className="live-phase">{PHASE_WORDS[t.phase] ?? t.phase}</span>
      </p>
      {last.length > 0 && (
        <ol className="live-turns">
          {hidden > 0 && <li className="lt quiet">{plural(hidden, "earlier step")}</li>}
          {last.map((turn, i) => (
            <LiveTurn key={hidden + i} turn={turn} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** The slim bar pinned under the masthead while a run is going: progress, cost, time left, Stop, and a peek at live conversations. */
export function RunBar({ run, what }: { run: Run; what: string }) {
  const { mode } = useAppData();
  const scn = useScenario(run.scenario);
  const now = useNow(1000);
  const [stop, setStop] = useState<{ busy?: boolean; sent?: boolean; msg?: string }>({});
  const [peek, setPeek] = useState(false);

  const done = run.trials.length;
  const total = run.config.total_trials;
  const frac = total ? Math.min(1, done / total) : 0;
  const live = run.live ?? [];
  const silent = silentFor(run, now);
  const stale = silent > STALE_S;
  const lat = run.trials.map((t) => t.latency_s).filter((x) => x > 0);
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
  const eta = avg !== null && total ? (avg * Math.max(0, total - done)) / WORKERS : null;
  const titles = Object.fromEntries((scn?.cases ?? []).map((c) => [c.id, c.title]));

  const onStop = async () => {
    setStop({ busy: true });
    const r = await stopRun(run.id);
    if (r.ok) setStop({ sent: true });
    else setStop({ msg: r.fromCli ? "Started from the terminal: stop it with Ctrl-C there." : `Could not stop: ${r.message}` });
  };

  return (
    <div className={`runbar${stale ? " is-stale" : ""}`} role="status" aria-live="polite">
      <div className="runbar-track" aria-hidden="true">
        <div className="runbar-fill" style={{ width: `${Math.max(2, frac * 100)}%` }} />
      </div>
      <div className="runbar-inner">
        {!stale && <span className="pulse" aria-hidden="true" />}
        <span className="runbar-what">{stale ? "Not responding" : what}</span>
        <span className="runbar-nums">
          {done}
          {total ? ` of ${total}` : ""} conversations
          <span className="sep">·</span>
          {usd(run.summary.cost_usd ?? 0)} so far
          {!stale && eta !== null && done < (total ?? 0) && (
            <>
              <span className="sep">·</span>about {dur(eta)} left
            </>
          )}
        </span>
        <span className="runbar-actions">
          {!stale && live.length > 0 && (
            <button type="button" className="link-btn" aria-expanded={peek} onClick={() => setPeek(!peek)}>
              {peek ? "Hide" : `Watch ${live.length} live`}
            </button>
          )}
          {mode === "local" && !stale && (
            <button type="button" className="btn btn-line btn-xs" onClick={onStop} disabled={stop.busy || stop.sent}>
              {stop.sent ? "Stopping…" : "Stop"}
            </button>
          )}
        </span>
      </div>
      {(stop.sent || stop.msg || stale) && (
        <p className="runbar-note">
          {stop.sent && "Stopping. Conversations in progress end within a few seconds; finished ones are kept."}
          {stop.msg && <span className="is-bad">{stop.msg}</span>}
          {stale &&
            `No activity for ${dur(silent)}. The process probably died (closed terminal, crash or restart). Finished conversations are kept; start a new run to finish the rest.`}
        </p>
      )}
      {peek && live.length > 0 && (
        <ol className="live-cards">
          {live.map((t) => (
            <LiveCard key={t.key} t={t} title={titles[t.case_id]} now={now} />
          ))}
        </ol>
      )}
    </div>
  );
}
