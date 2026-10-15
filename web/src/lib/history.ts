// A project's history, derived in the browser from its runs: checks over time, prompt versions, per-promise and
// per-test series, and run-to-run comparison. No extra endpoint needed: every run stores the prompt it ran with.
import { getVersion, listVersions } from "./api";
import { useAppData } from "./context";
import { useAsync } from "./hooks";
import { useRuns } from "./projects";
import type { EvalSummary, IndexEntry, Run, RuleStat, RuleVerdict, Trial } from "./types";
import { readRule, type RuleReading } from "./words";

export interface Version {
  key: string;
  label: string; // "v1", "v2"…
  /** saved version number (from the server's prompt history), when there is one */
  n?: number;
  note?: string | null;
  author?: string;
  sections: Record<string, string>;
  first: number; // epoch s of the first check that used it (or now for an unrun draft)
  runs: string[];
  unrun?: boolean;
}

export const promptKey = (s: Record<string, string> | undefined) => JSON.stringify(Object.entries(s ?? {}));

/** Distinct prompts the project's checks ran with, oldest first, plus the saved prompt if no check used it yet. */
export function versionsOf(evals: Run[], current?: Record<string, string>): Version[] {
  const out: Version[] = [];
  for (const r of [...evals].sort((a, b) => a.created - b.created)) {
    const sections = r.config.prompt;
    if (!sections) continue;
    const key = promptKey(sections);
    const v = out.find((x) => x.key === key);
    if (v) v.runs.push(r.id);
    else out.push({ key, label: `v${out.length + 1}`, sections, first: r.created, runs: [r.id] });
  }
  if (current && Object.keys(current).length && !out.some((v) => v.key === promptKey(current)))
    out.push({ key: promptKey(current), label: `v${out.length + 1}`, sections: current, first: Date.now() / 1000, runs: [], unrun: true });
  return out;
}

export function versionOfRun(versions: Version[], run: Run | undefined): Version | undefined {
  return run ? versions.find((v) => v.runs.includes(run.id)) : undefined;
}

export interface History {
  entries: IndexEntry[]; // every run of the project, newest first
  evals: Run[]; // finished (or stopped) checks with results, oldest first
  running?: IndexEntry;
  versions: Version[];
  loading: boolean;
}

/** The server's saved prompt versions (simulated projects); null where there is no history (Python projects, static demo). */
function useSavedVersions(name: string, current?: Record<string, string>) {
  const r = useAsync(async () => {
    const metas = await listVersions(name);
    return Promise.all(metas.map((m) => getVersion(name, m.n)));
  }, [name, promptKey(current)]);
  return r.error ? null : r.data;
}

/** All checks of one project, loaded and cached. */
export function useHistory(name: string, current?: Record<string, string>): History {
  const { runs } = useAppData();
  const entries = (runs ?? []).filter((r) => r.scenario === name).sort((a, b) => b.created - a.created);
  const evalEntries = entries.filter((r) => r.kind === "eval");
  const details = useRuns(evalEntries);
  const evals = evalEntries
    .filter((e) => e.status !== "running")
    .map((e) => details[e.id])
    .filter((r): r is Run => !!r && r.trials.length > 0)
    .sort((a, b) => a.created - b.created);
  const saved = useSavedVersions(name, current);
  const versions: Version[] = saved?.length
    ? saved.map((v) => {
        const key = promptKey(v.sections);
        const runs = evals
          .filter((r) => (r.config.prompt_version != null ? r.config.prompt_version === v.n : promptKey(r.config.prompt) === key))
          .map((r) => r.id);
        return { key, label: `v${v.n}`, n: v.n, note: v.note, author: v.author, sections: v.sections, first: v.created, runs, unrun: !runs.length };
      })
    : versionsOf(evals, current);
  return {
    entries,
    evals,
    running: entries.find((e) => e.status === "running"),
    versions,
    loading: !runs || evalEntries.some((e) => !details[e.id]),
  };
}

export const perRuleOf = (r: Run | undefined) => (r?.summary as Partial<EvalSummary> | undefined)?.per_rule ?? {};

export interface Point {
  run: Run;
  stat?: RuleStat;
  reading?: RuleReading;
}

export function ruleSeries(evals: Run[], id: string): Point[] {
  return evals.map((run) => {
    const stat = perRuleOf(run)[id];
    return { run, stat, reading: stat ? readRule(stat) : undefined };
  });
}

export function caseTrials(run: Run, caseId: string): Trial[] {
  return run.trials.filter((t) => t.variant === "base" && t.case_id === caseId).sort((a, b) => a.trial - b.trial);
}

// ---------- compare two checks ----------

export type Change = "fixed" | "regressed" | "better" | "worse" | "same" | "new" | "gone";

export interface RuleChange {
  id: string;
  before?: RuleReading & { stat: RuleStat };
  after?: RuleReading & { stat: RuleStat };
  change: Change;
}

const BAD: RuleVerdict[] = ["breaks", "flaky"];
/** A rate move this big counts as better/worse even when the verdict stays the same. */
const MOVE = 0.2;

export function classify(before?: RuleStat, after?: RuleStat): Change {
  if (!before && after) return "new";
  if (before && !after) return "gone";
  if (!before || !after) return "same";
  const b = readRule(before).verdict;
  const a = readRule(after).verdict;
  if (BAD.includes(b) && a === "holds") return "fixed";
  if (b === "holds" && BAD.includes(a)) return "regressed";
  if (after.rate <= before.rate - MOVE) return "better";
  if (after.rate >= before.rate + MOVE) return "worse";
  if (b === "flaky" && a === "breaks") return "worse";
  if (b === "breaks" && a === "flaky") return "better";
  return "same";
}

export function compareRuns(before: Run, after: Run, ids?: string[]): RuleChange[] {
  const pb = perRuleOf(before);
  const pa = perRuleOf(after);
  const all = ids ?? [...new Set([...Object.keys(pb), ...Object.keys(pa)])];
  return all
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
    .map((id) => ({
      id,
      before: pb[id] ? { ...readRule(pb[id]), stat: pb[id] } : undefined,
      after: pa[id] ? { ...readRule(pa[id]), stat: pa[id] } : undefined,
      change: classify(pb[id], pa[id]),
    }));
}

export function changeCounts(cs: RuleChange[]) {
  const n = (k: Change[]) => cs.filter((c) => k.includes(c.change)).length;
  return { fixed: n(["fixed", "better"]), regressed: n(["regressed", "worse"]), same: n(["same"]), other: n(["new", "gone"]) };
}

/** Sections whose text differs between two prompts. */
export function changedParts(a: Record<string, string> = {}, b: Record<string, string> = {}) {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return names.filter((n) => a[n] !== b[n]).map((n) => ({ name: n, before: a[n], after: b[n] }));
}

/** Median cost per conversation over the last five checks (what the server's estimate uses), else $0.012. */
export function perTrialCost(evals: Run[]): number {
  const xs = evals
    .slice(-5)
    .map((r) => (r.trials.length ? (r.summary.cost_usd ?? 0) / r.trials.length : 0))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  if (!xs.length) return 0.012;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
