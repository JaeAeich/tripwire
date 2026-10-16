// Compact summaries: a strip of numbers with short labels; explanations live behind a "?".
import type { ReactNode } from "react";
import { pct } from "../lib/format";
import type { RuleStat, RuleVerdict } from "../lib/types";
import { readRule } from "../lib/words";

/** A small "?" that shows its text on hover or focus. */
export function Help({ children }: { children: string }) {
  return (
    <span className="help" tabIndex={0} role="note" aria-label={children} data-tip={children}>
      ?
    </span>
  );
}

export interface StatItem {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "holds" | "breaks" | "flaky" | "too_few" | "skip";
  help?: string;
}

export function StatStrip({ items, className = "" }: { items: StatItem[]; className?: string }) {
  return (
    <dl className={`strip ${className}`}>
      {items.map((it) => (
        <div key={it.label} className={`strip-cell${it.tone ? ` tone-${it.tone}` : ""}`}>
          <dt>
            {it.tone && <span className="strip-dot" aria-hidden="true" />}
            {it.label}
            {it.help && <Help>{it.help}</Help>}
          </dt>
          <dd>
            <span className="strip-value">{it.value}</span>
            {it.sub && <span className="strip-sub">{it.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type Counts = Record<RuleVerdict, number>;

export function verdictCounts(perRule: Record<string, RuleStat> | undefined, ids: string[]): Counts {
  const out: Counts = { holds: 0, breaks: 0, flaky: 0, too_few: 0 };
  for (const id of ids) out[perRule?.[id] ? readRule(perRule[id]).verdict : "too_few"]++;
  return out;
}

/** "90%" with "70–97%" underneath. */
export function rateWithRange(x: number | null | undefined, ci?: [number, number]) {
  return { value: pct(x), sub: ci ? `likely ${pct(ci[0])}–${pct(ci[1])}` : undefined };
}

/** A tiny stacked bar of verdicts, for lists. */
export function VerdictBar({ c }: { c: Counts }) {
  const total = c.holds + c.breaks + c.flaky + c.too_few;
  if (!total) return <span className="vbar is-empty" />;
  const seg = (k: RuleVerdict) => (c[k] ? <span className={`vbar-${k}`} style={{ flexGrow: c[k] }} title={`${c[k]} ${k.replace("_", " ")}`} /> : null);
  return (
    <span className="vbar" role="img" aria-label={`${c.holds} hold, ${c.breaks} break, ${c.flaky} flaky, ${c.too_few} unsure`}>
      {seg("breaks")}
      {seg("flaky")}
      {seg("too_few")}
      {seg("holds")}
    </span>
  );
}
