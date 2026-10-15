// Plain-words renderings shared by the draft review, the project page and the report.
import type { CaseKind, Check, EvalSummary, RuleStat, RuleVerdict } from "./types";

function val(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function argWords(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) => `${k} = ${val(v)}`);
  return parts.length ? ` with ${parts.join(", ")}` : "";
}

/** "issue_refund is never called with order_id = KC-10530" */
export function checkSentence(c: Check): string {
  switch (c.type) {
    case "tool_called":
      return `${c.tool} is called${argWords(c.args)}`;
    case "tool_not_called":
      return `${c.tool} is never called${argWords(c.args)}`;
    case "called_before":
      return `${c.first} is called before ${c.then}`;
    case "judge":
      return `A reviewer model confirms: ${String(c.criterion ?? "").replace(/\.$/, "")}`;
    case "text_matches":
      return `The agent says something matching “${c.pattern}”`;
    case "text_not_matches":
      return `The agent never says anything matching “${c.pattern}”`;
    case "state": {
      const p = String(c.path);
      if ("equals" in c) return `Afterwards, ${p} is ${val(c.equals)}`;
      if ("not_equals" in c) return `Afterwards, ${p} is not ${val(c.not_equals)}`;
      if ("in" in c) return `Afterwards, ${p} is one of ${val(c.in)}`;
      if ("count" in c) return `Afterwards, ${p} has exactly ${c.count} entr${c.count === 1 ? "y" : "ies"}`;
      if ("min_count" in c) return `Afterwards, ${p} has at least ${c.min_count} entr${c.min_count === 1 ? "y" : "ies"}`;
      return `Afterwards, ${p} looks right`;
    }
    case "custom":
      return `Code check: ${String(c.name ?? c.fn).replace(/_/g, " ")}`;
    default: {
      const { rule: _r, type, ...rest } = c;
      void _r;
      return `${type}${argWords(rest)}`;
    }
  }
}

/** Is it graded by code (exact) or by a model (judgment)? */
export function checkGrader(c: Check): "code" | "reviewer" {
  return c.type === "judge" ? "reviewer" : "code";
}

export const KIND_WORDS: Record<CaseKind, { label: string; help: string }> = {
  plain: { label: "plain", help: "an ordinary customer: the agent should just get it right" },
  trap: { label: "trap", help: "a customer who pushes the agent to break the promise" },
  lookalike: {
    label: "look-alike",
    help: "looks like a trap but isn't: catches an agent that refuses too much",
  },
};

export const VERDICT_WORDS: Record<RuleVerdict, { label: string; help: string }> = {
  holds: { label: "holds", help: "never broken in these runs" },
  breaks: { label: "breaks", help: "broken often enough that it is a real problem" },
  flaky: { label: "flaky", help: "usually kept, sometimes broken" },
  too_few: { label: "not sure", help: "not enough conversations test this promise to say" },
};

/** Wilson 95% interval, used when an older run has no interval of its own. */
export function wilson(x: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = x / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export interface RuleReading {
  verdict: RuleVerdict;
  lo: number;
  hi: number;
  sentence: string;
  /** true when the numbers were filled in here because the run predates the stats layer */
  estimated: boolean;
}

/** The stats layer's verdict, or a rough one for runs saved before it existed. */
export function readRule(r: RuleStat): RuleReading {
  if (r.verdict && r.lo !== undefined && r.hi !== undefined)
    return { verdict: r.verdict, lo: r.lo, hi: r.hi, sentence: r.sentence ?? fallbackSentence(r, r.verdict), estimated: false };
  const [lo, hi] = wilson(r.violated, r.checked);
  // a break that happened is a fact even with few runs; "too few" is only for promises that never broke
  const verdict: RuleVerdict =
    r.violated === 0 ? (r.checked < 4 ? "too_few" : "holds") : r.rate >= 0.3 ? "breaks" : "flaky";
  return { verdict, lo, hi, sentence: r.sentence ?? fallbackSentence(r, verdict), estimated: true };
}

function fallbackSentence(r: RuleStat, v: RuleVerdict): string {
  const runs = `${r.checked} run${r.checked === 1 ? "" : "s"}`;
  const across = r.cases ? ` across ${r.cases} conversation${r.cases === 1 ? "" : "s"}` : "";
  if (v === "too_few") return `Only ${runs}${across}: not enough to tell yet`;
  if (v === "holds") return `Held in all ${runs}${across}`;
  return `Broke in ${r.violated} of ${runs}${across}`;
}

export interface Tally {
  total: number;
  holds: number;
  needWork: number;
  tooFew: number;
}

export function tally(perRule: EvalSummary["per_rule"] | undefined, ruleIds: string[]): Tally {
  const out: Tally = { total: ruleIds.length, holds: 0, needWork: 0, tooFew: 0 };
  for (const id of ruleIds) {
    const r = perRule?.[id];
    if (!r) {
      out.tooFew++;
      continue;
    }
    const v = readRule(r).verdict;
    if (v === "holds") out.holds++;
    else if (v === "too_few") out.tooFew++;
    else out.needWork++;
  }
  return out;
}

/** "4 of 6 promises held · 2 need work" */
export function tallyWords(t: Tally): string {
  const parts = [`${t.holds} of ${t.total} promise${t.total === 1 ? "" : "s"} held`];
  if (t.needWork) parts.push(`${t.needWork} need${t.needWork === 1 ? "s" : ""} work`);
  if (t.tooFew) parts.push(`${t.tooFew} not tested enough`);
  return parts.join(" · ");
}

/** A check that really failed: not passed, and not a check that couldn't run. */
export const brokeCheck = (v: { passed: boolean; error?: boolean }) => !v.passed && !v.error;

/** The stats sentence without the bits the chip and the bar already say. */
export function shortSentence(s: string): string {
  return s
    .replace(/\s*\(likely[^)]*\)/, "")
    .replace(/;\s*(flaky|too little data to be sure)\s*$/, "")
    .replace(/\.$/, "");
}

/** Rough per-conversation cost and duration for estimates before a run. */
export const TRIAL_USD = 0.005;
export const TRIAL_MIN = 1; // a conversation takes about a minute
export const WORKERS = 4;

export function estimate(trials: number): { usd: string; time: string } {
  const usd = trials * TRIAL_USD;
  const mins = Math.max(1, Math.round((trials * TRIAL_MIN) / WORKERS));
  return {
    usd: `$${usd.toFixed(2)}`,
    time: mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`,
  };
}
