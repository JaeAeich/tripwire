// Plain-language reading of an attribution matrix. One place, so the run page, the eval page and the home list agree.
import { pct } from "./format";
import type { AttributionSummary, Cell, Rule } from "./types";

/** A difference this big is worth mentioning as "maybe" even when the interval crosses zero. */
export const MAYBE_DELTA = 0.25;

export type Effect = "holds" | "causes";
export type Sure = "clear" | "maybe";

export interface Claim {
  cell: Cell;
  effect: Effect;
  sure: Sure;
}

export function claimOf(c: Cell): Claim | null {
  if (c.role === "load-bearing") return { cell: c, effect: "holds", sure: "clear" };
  if (c.role === "culprit") return { cell: c, effect: "causes", sure: "clear" };
  if (Math.abs(c.delta) >= MAYBE_DELTA) return { cell: c, effect: c.delta > 0 ? "holds" : "causes", sure: "maybe" };
  return null;
}

/** Claims for one section, strongest first (clear before maybe, then by size). */
export function sectionClaims(matrix: Cell[], section: string): Claim[] {
  return matrix
    .filter((c) => c.section === section)
    .map(claimOf)
    .filter((x): x is Claim => x !== null)
    .sort((a, b) => (a.sure === b.sure ? Math.abs(b.cell.delta) - Math.abs(a.cell.delta) : a.sure === "clear" ? -1 : 1));
}

export function ruleName(id: string, rules: Record<string, Rule>): string {
  return rules[id] ? `${id} ${rules[id].title}` : id;
}

/** "This part holds promise R3 ‘Refund policy’ up" / "This part causes R5 ‘Mandatory escalation’ to break" */
export function claimTitle(cl: Claim, rules: Record<string, Rule>): string {
  const id = cl.cell.rule;
  const r = rules[id] ? `${id} ‘${rules[id].title}’` : id;
  const may = cl.sure === "maybe";
  return cl.effect === "holds"
    ? `This part ${may ? "may hold" : "holds"} promise ${r} up`
    : `This part ${may ? "may cause" : "causes"} ${r} to break`;
}

/** ": without it, R3 broke in 100% of runs (vs 42% with it)." */
export function claimEvidence(c: Cell): string {
  return `without it, ${c.rule} broke in ${pct(c.ablated_rate)} of runs (vs ${pct(c.base_rate)} with it).`;
}

/** The sentence the Python summary writes into headline.top, recomputed for runs saved before it existed. */
export function topSentence(s: Partial<AttributionSummary> | undefined): string | null {
  if (!s) return null;
  let top = s.headline?.top ?? null;
  if (!top) {
    const m = s.matrix ?? [];
    const culprits = m.filter((c) => c.role === "culprit").sort((a, b) => a.delta - b.delta);
    const holding = m.filter((c) => c.role === "load-bearing").sort((a, b) => b.delta - a.delta);
    const c = culprits[0] ?? holding[0];
    if (!c) return null;
    top = `Removing '${c.section}' ${c.delta < 0 ? "cut" : "raised"} ${c.rule} violations from ${pct(c.base_rate)} to ${pct(c.ablated_rate)}`;
  }
  top = top.replace(/'([^']+)'/g, "‘$1’");
  top = plainTop(top);
  return /[.!?]$/.test(top) ? top : `${top}.`;
}

/** "Removing ‘Tone’ cut R7 violations from 100% to 0%" -> "The ‘Tone’ part causes R7 to break: …" */
function plainTop(s: string): string {
  const m = /^Removing (‘[^’]+’) (cut|raised) (\S+) violations from (\S+) to (\S+?)\.?$/.exec(s);
  if (!m) return s;
  const [, sec, dir, rule, a, b] = m;
  return dir === "cut"
    ? `The ${sec} part causes ${rule} to break: it broke in ${a} of runs with it, ${b} without`
    : `The ${sec} part holds ${rule} up: it broke in ${a} of runs with it, ${b} without`;
}
