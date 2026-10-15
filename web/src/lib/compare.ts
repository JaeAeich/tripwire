// A browser port of src/tripwire/compare.py, for the mock and for the static demo (where there is no server).
// Same shape as GET /api/runs/{a}/compare/{b}; the interval is a plain normal approximation, not the server's.
import type { CompareChange, CompareResult, CompareRow, RuleResult, Run } from "./types";
import { wilson } from "./words";

type Cells = Record<string, Record<string, [number, number]>>;

function cellsOf(run: Run): Cells {
  const variant = run.kind === "attack" ? "attack" : "base";
  const out: Cells = {};
  for (const t of run.trials) {
    if (t.error || t.variant !== variant) continue;
    const vs = t.verdicts.filter((v) => !v.error);
    for (const rule of new Set(vs.map((v) => v.rule))) {
      const c = ((out[rule] ??= {})[t.case_id] ??= [0, 0]);
      c[0] += vs.some((v) => v.rule === rule && !v.passed) ? 1 : 0;
      c[1] += 1;
    }
  }
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pts = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(Math.round(x * 100))}`;

function table(cs: Record<string, [number, number]>): RuleResult {
  const v = Object.values(cs).reduce((a, [x]) => a + x, 0);
  const n = Object.values(cs).reduce((a, [, y]) => a + y, 0);
  const [lo, hi] = wilson(v, n);
  const cases = Object.keys(cs).length;
  const verdict = !v ? (n < 4 || cases < 2 ? "too_few" : "holds") : v / n >= 0.3 ? "breaks" : "flaky";
  const sentence = v ? `Broke in ${v} of ${n} runs across ${cases} conversations` : `Held in all ${n} runs across ${cases} conversations`;
  return { violated: v, checked: n, cases, rate: n ? v / n : null, lo, hi, verdict, sentence };
}

export function compareLocal(a: Run, b: Run): CompareResult {
  const ca = cellsOf(a);
  const cb = cellsOf(b);
  const per_rule: Record<string, CompareRow> = {};
  for (const rule of [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))) {
    const before = ca[rule] ? table(ca[rule]) : null;
    const after = cb[rule] ? table(cb[rule]) : null;
    if (!after) {
      per_rule[rule] = { before, after, change: "not_rerun", sentence: `${rule} wasn't checked in the second run` };
      continue;
    }
    if (!before) {
      per_rule[rule] = { before, after, change: "new", sentence: `${rule} wasn't checked in the first run; now: ${after.sentence}` };
      continue;
    }
    const shared = Object.keys(ca[rule]).filter((c) => cb[rule][c]);
    let d: number;
    let lo: number;
    let hi: number;
    if (shared.length) {
      const diffs = shared.map((c) => cb[rule][c][0] / cb[rule][c][1] - ca[rule][c][0] / ca[rule][c][1]);
      d = diffs.reduce((x, y) => x + y, 0) / diffs.length;
      const sd = Math.sqrt(diffs.reduce((x, y) => x + (y - d) ** 2, 0) / Math.max(1, diffs.length - 1));
      const se = Math.max(0.12, sd / Math.sqrt(diffs.length));
      lo = d - 1.96 * se;
      hi = d + 1.96 * se;
    } else {
      d = (after.rate ?? 0) - (before.rate ?? 0);
      lo = after.lo - before.hi;
      hi = after.hi - before.lo;
    }
    lo = Math.max(-1, lo);
    hi = Math.min(1, hi);
    const change: CompareChange = hi < 0 ? "fixed" : lo > 0 ? "regressed" : "same";
    const tail = change === "fixed" ? "fixed" : change === "regressed" ? "regressed" : "can't tell a difference yet";
    per_rule[rule] = {
      before,
      after,
      change,
      delta: d,
      lo,
      hi,
      paired_cases: shared.length,
      leaning: change !== "same" || Math.round(d * 100) === 0 ? null : d < 0 ? "better" : "worse",
      sentence: `${rule} failures ${pct(before.rate ?? 0)} → ${pct(after.rate ?? 0)} (likely ${pts(lo)} to ${pts(hi)} pts, ${shared.length} shared conversations): ${tail}`,
    };
  }
  const by = (ch: CompareChange) => Object.keys(per_rule).filter((r) => per_rule[r].change === ch);
  return {
    a: a.id,
    b: b.id,
    scenario: b.scenario,
    prompt_versions: [a.config.prompt_version ?? null, b.config.prompt_version ?? null],
    per_rule,
    fixed: by("fixed"),
    regressed: by("regressed"),
    same: by("same"),
    new: by("new"),
    not_rerun: by("not_rerun"),
    sentence: `${by("fixed").length} fixed, ${by("regressed").length} regressed, ${by("same").length} no clear change${by("new").length ? `, ${by("new").length} new` : ""}`,
  };
}
