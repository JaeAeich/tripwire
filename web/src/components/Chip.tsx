// The one chip. Every status, verdict, kind and tag in the app is a Chip with one of these tones.
import type { ReactNode } from "react";
import type { RuleVerdict } from "../lib/types";

export type ChipTone = "holds" | "breaks" | "flaky" | "unsure" | "skip" | "neutral";

export function Chip({ tone = "neutral", dot, title, children }: { tone?: ChipTone; dot?: boolean; title?: string; children: ReactNode }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {dot && <span className="chip-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export const verdictTone = (v: RuleVerdict): ChipTone => (v === "too_few" ? "unsure" : v);
