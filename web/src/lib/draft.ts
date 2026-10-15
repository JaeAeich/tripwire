// A project as an editable Draft, and the small pure edits every editor shares. Edits are functions of the latest
// draft (by id, never by index), so two quick saves can't overwrite each other.
import type { Case, Check, Draft, DraftCase, Rule, Scenario, ScenarioDetail } from "./types";

/** A case as the server stores it: only the keys it has. Keeps script, max_turns and anything else on the case. */
export function asDraftCase(c: Case | DraftCase): DraftCase {
  const out: DraftCase = { id: c.id, title: c.title, why: c.why ?? "", kind: c.kind ?? "plain", checks: c.checks ?? [] };
  if (Array.isArray(c.script) && c.script.length) out.script = c.script;
  else out.persona = c.persona ?? {};
  if (typeof c.max_turns === "number") out.max_turns = c.max_turns;
  return out;
}

/** GET /api/scenarios/{name} as a Draft. Nothing the server sent is dropped (title, defaults, script, max_turns). */
export function asDraft(s: ScenarioDetail): Draft {
  return {
    name: s.name,
    ...(s.title ? { title: s.title } : {}),
    description: s.description,
    ...(s.defaults ? { defaults: s.defaults } : {}),
    sections: s.sections,
    rules: s.rules,
    tools: s.tools ?? [],
    world: s.world ?? "",
    fixtures: s.fixtures ?? {},
    cases: s.cases.map(asDraftCase),
    notes: s.notes ?? [],
  };
}

/** The list entry the app shows, from a draft (used to show a save right away, before the list reloads). */
export function draftToScenario(d: Draft, prev?: Scenario): Scenario {
  const hashes = Object.fromEntries((prev?.cases ?? []).map((c) => [c.id, c.hash]));
  return {
    ...(prev ?? {}),
    name: d.name,
    title: d.title,
    description: d.description,
    rules: d.rules,
    sections: d.sections,
    defaults: d.defaults ?? prev?.defaults,
    notes: d.notes,
    cases: d.cases.map((c) => ({
      id: c.id,
      title: c.title,
      why: c.why,
      kind: c.kind,
      persona: c.persona ?? null,
      script: c.script ?? null,
      checks: c.checks,
      max_turns: c.max_turns ?? null,
      hash: hashes[c.id],
    })),
  };
}

export const displayName = (s: { name: string; title?: string } | undefined, fallback = "") => s?.title?.trim() || s?.name || fallback;

export function nextRuleId(rules: Rule[]): string {
  const n = Math.max(0, ...rules.map((r) => Number(/\d+/.exec(r.id)?.[0] ?? 0)));
  return `R${n + 1}`;
}

export function nextCaseId(cases: { id: string }[]): string {
  const n = Math.max(0, ...cases.map((c) => Number(/^\d+/.exec(c.id)?.[0] ?? 0)));
  return String(n + 1).padStart(2, "0");
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

// ---------- edits ----------

export const setRule = (id: string, patch: Partial<Rule>) => (d: Draft): Draft => ({
  ...d,
  rules: d.rules.map((r) => {
    if (r.id !== id) return r;
    const next = { ...r, ...patch };
    if (!next.source_section) delete next.source_section;
    return next;
  }),
});

export const addRule = (r: Rule) => (d: Draft): Draft => ({ ...d, rules: [...d.rules, { ...r, id: nextRuleId(d.rules) }] });

/** Delete a promise, its checks, and tests left with no check. */
export const deleteRule = (id: string) => (d: Draft): Draft => ({
  ...d,
  rules: d.rules.filter((r) => r.id !== id),
  cases: d.cases.map((c) => ({ ...c, checks: c.checks.filter((ch) => ch.rule !== id) })).filter((c) => c.checks.length > 0),
});

export const setCase = (id: string, fn: (c: DraftCase) => DraftCase) => (d: Draft): Draft => ({
  ...d,
  cases: d.cases.map((c) => (c.id === id ? fn(c) : c)),
});

export const deleteCase = (id: string) => (d: Draft): Draft => ({ ...d, cases: d.cases.filter((c) => c.id !== id) });

export const duplicateCase = (id: string) => (d: Draft): Draft => {
  const i = d.cases.findIndex((c) => c.id === id);
  if (i < 0) return d;
  const copy = { ...structuredClone(d.cases[i]), id: nextCaseId(d.cases), title: `${d.cases[i].title} (copy)` };
  return { ...d, cases: [...d.cases.slice(0, i + 1), copy, ...d.cases.slice(i + 1)] };
};

/** A starting test for a promise: a plain customer and a reviewer check against the promise's own words. */
export function newCaseFor(rule: Rule | undefined, cases: { id: string }[]): DraftCase {
  return {
    id: nextCaseId(cases),
    title: rule ? `New test for ${rule.id}` : "New test",
    why: "",
    kind: "plain",
    persona: { who: "A customer", goal: rule ? `Gets help with something where ${rule.id} (${rule.title || "this promise"}) matters` : "Gets help with their order", pushback: 1 },
    checks: rule ? [{ rule: rule.id, type: "judge", criterion: `Did the agent keep this promise: ${rule.text.replace(/\.$/, "")}?` }] : [],
  };
}

export const addCase = (c: DraftCase) => (d: Draft): Draft => ({ ...d, cases: [...d.cases, { ...c, id: nextCaseId(d.cases) }] });

/** Rename a prompt part in place (order kept); promises from it follow. */
export function renamePart(sections: Record<string, string>, from: string, to: string): Record<string, string> {
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k === from ? to : k, v]));
}

export function movePart(sections: Record<string, string>, name: string, by: -1 | 1): Record<string, string> {
  const keys = Object.keys(sections);
  const i = keys.indexOf(name);
  const j = i + by;
  if (i < 0 || j < 0 || j >= keys.length) return sections;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  return Object.fromEntries(keys.map((k) => [k, sections[k]]));
}

/** Apply part renames/removals to promises, the way the server does with `renames`. */
export function followRenames(rules: Rule[], renames: Record<string, string | null>): Rule[] {
  return rules.map((r) => {
    if (!r.source_section || !(r.source_section in renames)) return r;
    const to = renames[r.source_section];
    const { source_section: _s, ...rest } = r;
    void _s;
    return to ? { ...rest, source_section: to } : rest;
  });
}

/** Problems with a part name, or null. */
export function partNameProblem(name: string, sections: Record<string, string>, current?: string): string | null {
  const n = name.trim();
  if (!n) return "A part needs a name";
  if (/^#/.test(n)) return "Leave out the ##";
  if (n !== current && Object.keys(sections).some((k) => k.toLowerCase() === n.toLowerCase())) return "Another part has that name";
  if (n === "preamble" && current !== "preamble") return "“preamble” is reserved for the opening lines";
  return null;
}

// ---------- checks ----------

export interface CheckSpec {
  type: string;
  label: string;
  grader: "exact" | "judgment";
  /** a fresh check of this type */
  make: (rule: string, tools: string[]) => Check;
}

/** The check types the grader knows (src/tripwire/core/graders.py, draft/validate.py CHECK_TYPES). */
export const CHECK_SPECS: CheckSpec[] = [
  { type: "judge", label: "a reviewer model confirms", grader: "judgment", make: (rule) => ({ rule, type: "judge", criterion: "" }) },
  { type: "tool_called", label: "a tool is called", grader: "exact", make: (rule, t) => ({ rule, type: "tool_called", tool: t[0] ?? "" }) },
  { type: "tool_not_called", label: "a tool is never called", grader: "exact", make: (rule, t) => ({ rule, type: "tool_not_called", tool: t[0] ?? "" }) },
  { type: "called_before", label: "one tool is called before another", grader: "exact", make: (rule, t) => ({ rule, type: "called_before", first: t[0] ?? "", then: t[1] ?? t[0] ?? "" }) },
  { type: "text_matches", label: "the agent says something matching", grader: "exact", make: (rule) => ({ rule, type: "text_matches", pattern: "" }) },
  { type: "text_not_matches", label: "the agent never says anything matching", grader: "exact", make: (rule) => ({ rule, type: "text_not_matches", pattern: "" }) },
  { type: "state", label: "afterwards, the data looks like", grader: "exact", make: (rule) => ({ rule, type: "state", path: "", equals: "" }) },
];

export const STATE_OPS = ["equals", "not_equals", "in", "count", "min_count"] as const;
export type StateOp = (typeof STATE_OPS)[number];
export const STATE_OP_WORDS: Record<StateOp, string> = { equals: "is", not_equals: "is not", in: "is one of", count: "has exactly", min_count: "has at least" };

/** Switch a check to another type, keeping its promise and whatever still applies. */
export function retypeCheck(ch: Check, type: string, tools: string[]): Check {
  const spec = CHECK_SPECS.find((s) => s.type === type);
  if (!spec) return ch;
  const fresh = spec.make(ch.rule, tools);
  if ((type === "tool_called" || type === "tool_not_called") && typeof ch.tool === "string") return { ...fresh, tool: ch.tool, ...(ch.args ? { args: ch.args } : {}) };
  if ((type === "text_matches" || type === "text_not_matches") && typeof ch.pattern === "string") return { ...fresh, pattern: ch.pattern };
  return fresh;
}

/** Why a check can't be saved yet, or null. */
export function checkProblem(ch: Check, tools: string[], rules: string[]): string | null {
  if (!rules.includes(ch.rule)) return `${ch.rule || "?"} is not a promise`;
  switch (ch.type) {
    case "tool_called":
    case "tool_not_called":
      return tools.includes(String(ch.tool)) ? null : "Pick a tool";
    case "called_before":
      return tools.includes(String(ch.first)) && tools.includes(String(ch.then)) ? null : "Pick both tools";
    case "judge":
      return String(ch.criterion ?? "").trim() ? null : "Say what the reviewer checks";
    case "text_matches":
    case "text_not_matches":
      if (!String(ch.pattern ?? "")) return "Give a pattern";
      try {
        new RegExp(String(ch.pattern));
        return null;
      } catch {
        return "That pattern is not a valid regular expression";
      }
    case "state":
      return String(ch.path ?? "").trim() ? null : "Give a path, e.g. orders.TB-1001.status";
    default:
      return null;
  }
}

/** Parse JSON text; returns [value, null] or [undefined, problem]. */
export function parseJSON(text: string, want: "object" | "any" = "any"): [unknown, string | null] {
  if (!text.trim()) return want === "object" ? [{}, null] : [undefined, "Empty"];
  try {
    const v = JSON.parse(text);
    if (want === "object" && (typeof v !== "object" || v === null || Array.isArray(v))) return [undefined, "Must be a JSON object: { … }"];
    return [v, null];
  } catch (e) {
    return [undefined, `Not valid JSON: ${(e as Error).message.replace(/^JSON\.parse: /, "")}`];
  }
}
