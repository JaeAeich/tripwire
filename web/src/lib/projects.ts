import { useEffect, useState } from "react";
import { getRun } from "./api";
import type { EvalSummary, IndexEntry, Run, Scenario } from "./types";
import { tally, tallyWords, type Tally } from "./words";

const cache = new Map<string, Run>();
const keyOf = (r: IndexEntry) => `${r.id}:${r.updated ?? ""}:${r.status}`;

/** Fetch full runs for these index entries (cached per save). */
export function useRuns(entries: IndexEntry[]): Record<string, Run> {
  const [out, setOut] = useState<Record<string, Run>>({});
  const key = entries.map(keyOf).join(",");
  useEffect(() => {
    let live = true;
    Promise.all(
      entries.map(async (e) => {
        const k = keyOf(e);
        if (!cache.has(k) || e.status === "running") {
          try {
            cache.set(k, await getRun(e.id));
          } catch {
            /* skip */
          }
        }
        return [e.id, cache.get(k)] as const;
      }),
    ).then((pairs) => {
      if (!live) return;
      const next: Record<string, Run> = {};
      for (const [id, r] of pairs) if (r) next[id] = r;
      setOut(next);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return out;
}

/** Finished (or stopped) evals of one project, newest first. */
export function evalsOf(runs: IndexEntry[] | undefined, scenario: string): IndexEntry[] {
  return (runs ?? []).filter((r) => r.kind === "eval" && r.scenario === scenario).sort((a, b) => b.created - a.created);
}

export function runTally(run: Run | undefined, scn: Scenario | { rules: { id: string }[] } | undefined): Tally | null {
  if (!run || !scn) return null;
  const s = run.summary as Partial<EvalSummary>;
  if (!s.per_rule || !run.trials.length) return null;
  const ids = scn.rules.map((r) => r.id);
  return tally(s.per_rule, ids.length ? ids : Object.keys(s.per_rule));
}

export function runTallyWords(run: Run | undefined, scn: Scenario | { rules: { id: string }[] } | undefined): string | null {
  const t = runTally(run, scn);
  return t ? tallyWords(t) : null;
}
