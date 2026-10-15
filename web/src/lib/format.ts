export function pct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `${(x * 100).toFixed(digits)}%`;
}

/** Signed percentage points, with a real minus sign. */
export function pts(x: number): string {
  const v = Math.round(x * 100);
  if (v === 0) return "0";
  return `${v < 0 ? "−" : "+"}${Math.abs(v)}`;
}

export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined) return "n/a";
  if (x === 0) return "$0";
  if (x < 0.01) return `$${x.toFixed(4)}`;
  if (x < 1) return `$${x.toFixed(3)}`;
  return `$${x.toFixed(2)}`;
}

export function secs(x: number): string {
  if (x < 60) return `${x.toFixed(1)}s`;
  const m = Math.floor(x / 60);
  return `${m}m ${Math.round(x - m * 60)}s`;
}

export function ago(unixSeconds: number, now = Date.now()): string {
  const d = Math.max(0, now / 1000 - unixSeconds);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  const days = Math.floor(d / 86400);
  if (days < 30) return `${days} d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export function stamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function json(v: unknown): string {
  if (v === undefined) return "undefined";
  return JSON.stringify(v);
}

export function variantLabel(v: string): string {
  return v === "base" ? "full prompt" : `without the ‘${v.replace(/^ablate:/, "")}’ section`;
}

/** Whole seconds as "45s", "3m 05s", "1h 12m". */
export function dur(x: number): string {
  const s = Math.max(0, Math.round(x));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const PHASE_WORDS: Record<string, string> = {
  customer: "customer is writing…",
  agent: "agent is thinking…",
  grading: "checking the promises…",
};

/** "02 ‘Angry customer, $120 over the limit’" */
export function caseName(id: string, title?: string): string {
  return title ? `${id} ‘${title}’` : id;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Grader steps: the explicit step, or a "step N" mentioned in the detail (custom checks only say it in words). */
export function verdictStep(v: { step: number | null; detail: string }): number | null {
  if (typeof v.step === "number") return v.step;
  const m = /\bstep (\d+)\b/.exec(v.detail || "");
  return m ? Number(m[1]) : null;
}

/** Path a state check reads, from its label: "state path=transactions[id=t_1].status". */
export function checkPath(check: string): string | null {
  const m = /\bpath=(\S+)/.exec(check);
  return m ? m[1] : null;
}

/** Plain-language version of a grader detail where the raw one is cryptic. */
export function readableDetail(v: { check: string; detail: string; passed: boolean }): string {
  const tool = /\btool=(\S+)/.exec(v.check)?.[1];
  if (!v.passed && tool && v.check.startsWith("tool_called") && /^0 matching/.test(v.detail))
    return `${tool} was never called`;
  if (!v.passed && tool && v.check.startsWith("tool_not_called")) {
    const m = /called at step (\d+)/.exec(v.detail);
    if (m) return `${tool} was called at step ${m[1]}, and it should not have been`;
  }
  return v.detail || (v.passed ? "ok" : "failed");
}
