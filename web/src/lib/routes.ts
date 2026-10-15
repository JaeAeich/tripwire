import type { Trial } from "./types";

export const runHref = (id: string) => `/runs/${encodeURIComponent(id)}`;
export const scenarioHref = (name: string) => `/scenarios/${encodeURIComponent(name)}`;

export function trialHref(runId: string, t: Pick<Trial, "variant" | "case_id" | "trial">, step?: number | null) {
  const base = `${runHref(runId)}/t/${encodeURIComponent(t.variant)}/${encodeURIComponent(t.case_id)}/${t.trial}`;
  return step === null || step === undefined ? base : `${base}?step=${step}`;
}

export const compareHref = (runId: string, section: string, rule: string) =>
  `${runHref(runId)}/compare/${encodeURIComponent(section)}/${encodeURIComponent(rule)}`;
