// Everything known about one promise in one check, gathered once: verdict, the prompt part, map numbers, every
// failing conversation with its excerpt. The evidence panel renders it for humans; briefFor() turns it into a
// self-contained markdown / JSON brief for an agent.
import { placeRules } from "./anchor";
import { readableDetail, verdictStep } from "./format";
import type { AttackCase, AttributionSummary, Case, Cell, Persona, Rule, Run, Scenario, Trial, Turn, Verdict } from "./types";
import { readRule, shortSentence, type RuleReading } from "./words";

export interface Failure {
  run: Run;
  trial: Trial;
  case?: Case | AttackCase;
  kind: string;
  angle?: string;
  verdicts: Verdict[];
  step: number | null;
  excerpt: { index: number; turn: Turn; hit: boolean }[];
}

export interface Evidence {
  rule: Rule;
  run?: Run;
  reading?: RuleReading;
  rate?: number;
  section: string | null;
  sectionText?: string;
  map?: { run: Run; cell: Cell; withBroke: number; withN: number; withoutBroke: number; withoutN: number };
  failures: Failure[];
  tests: (Case | AttackCase)[];
  others: { rule: Rule; verdict: string }[];
}

function excerptOf(trial: Trial, step: number | null) {
  const turns = trial.turns;
  if (!turns.length) return [];
  const at = step ?? (() => {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "agent") return i;
    return turns.length - 1;
  })();
  // what the customer said last, the step that broke it, and what came right after
  let ask = -1;
  for (let i = at - 1; i >= 0; i--)
    if (turns[i].role === "user") {
      ask = i;
      break;
    }
  const idx = [...new Set([ask, at, at + 1].filter((i) => i >= 0 && i < turns.length))].sort((a, b) => a - b);
  return idx.map((i) => ({ index: i, turn: turns[i], hit: i === at }));
}

function failuresIn(run: Run, ruleId: string, cases: Record<string, Case | AttackCase>, variant: string): Failure[] {
  const out: Failure[] = [];
  for (const t of run.trials) {
    if (t.variant !== variant || t.error) continue;
    const vs = t.verdicts.filter((v) => v.rule === ruleId && !v.passed && !v.error);
    if (!vs.length) continue;
    const steps = vs.map(verdictStep).filter((x): x is number => x !== null);
    const step = steps.length ? Math.min(...steps) : null;
    const c = cases[t.case_id];
    out.push({
      run,
      trial: t,
      case: c,
      kind: c?.kind ?? "plain",
      angle: c && "angle" in c ? (c as AttackCase).angle : undefined,
      verdicts: vs,
      step,
      excerpt: excerptOf(t, step),
    });
  }
  return out;
}

export function gather(scn: Scenario, ruleId: string, run?: Run, mapRun?: Run | null, attacks: Run[] = []): Evidence | null {
  const rule = scn.rules.find((r) => r.id === ruleId);
  if (!rule) return null;
  const sections = run?.config.prompt ?? scn.sections;
  const section = placeRules(sections, scn.rules)[ruleId] ?? null;
  const stat = (run?.summary as { per_rule?: Record<string, import("./types").RuleStat> } | undefined)?.per_rule?.[ruleId];
  const cases: Record<string, Case | AttackCase> = Object.fromEntries(scn.cases.map((c) => [c.id, c]));
  const failures = run ? failuresIn(run, ruleId, cases, "base") : [];
  for (const a of attacks) {
    const ac: Record<string, Case | AttackCase> = Object.fromEntries((a.config.attacks ?? []).map((c) => [c.id, c]));
    failures.push(...failuresIn(a, ruleId, ac, "attack"));
  }
  let map: Evidence["map"];
  const cells = ((mapRun?.summary as Partial<AttributionSummary> | undefined)?.matrix ?? []).filter((c) => c.rule === ruleId);
  const cell = (section ? cells.find((c) => c.section === section) : undefined) ?? [...cells].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  if (mapRun && cell)
    map = {
      run: mapRun,
      cell,
      withBroke: Math.round(cell.base_rate * cell.n[0]),
      withN: cell.n[0],
      withoutBroke: Math.round(cell.ablated_rate * cell.n[1]),
      withoutN: cell.n[1],
    };
  const per = (run?.summary as { per_rule?: Record<string, import("./types").RuleStat> } | undefined)?.per_rule ?? {};
  return {
    rule,
    run,
    reading: stat ? readRule(stat) : undefined,
    rate: stat?.rate,
    section,
    sectionText: section ? sections[section] : undefined,
    map,
    failures,
    tests: scn.cases.filter((c) => (c.checks ?? []).some((ch) => ch.rule === ruleId)),
    others: scn.rules.filter((r) => r.id !== ruleId).map((r) => ({ rule: r, verdict: per[r.id] ? readRule(per[r.id]).verdict : "not run" })),
  };
}

const ROLE: Record<string, string> = { user: "customer", agent: "agent", tool: "tool call" };

function turnText(t: Turn): string {
  if (t.tool_call) return `${t.tool_call.name}(${JSON.stringify(t.tool_call.args)}) → ${JSON.stringify(t.tool_call.result)}`;
  return (t.text ?? "").replace(/\s+/g, " ").trim();
}

function personaLine(p?: Persona | null): string {
  if (!p) return "";
  return [p.who, p.goal && `wants: ${p.goal}`, p.style && `style: ${p.style}`].filter(Boolean).join("; ");
}

export function briefJSON(e: Evidence, project: string) {
  return {
    project,
    run: e.run?.id,
    models: e.run?.config.models,
    promise: { id: e.rule.id, title: e.rule.title, text: e.rule.text },
    verdict: e.reading ? { verdict: e.reading.verdict, broke: e.rate, likely: [e.reading.lo, e.reading.hi], summary: shortSentence(e.reading.sentence) } : null,
    prompt_part: e.section ? { name: e.section, text: e.sectionText } : null,
    map: e.map
      ? { part: e.map.cell.section, with_part: `${e.map.withBroke}/${e.map.withN}`, without_part: `${e.map.withoutBroke}/${e.map.withoutN}`, role: e.map.cell.role }
      : null,
    failures: e.failures.map((f) => ({
      test: f.case ? { id: f.case.id, title: f.case.title, kind: f.kind, angle: f.angle, customer: personaLine(f.case.persona) } : { id: f.trial.case_id },
      run: f.run.id,
      try: f.trial.trial + 1,
      step: f.step,
      checks: f.verdicts.map((v) => ({ check: v.check, why: readableDetail(v) })),
      excerpt: f.excerpt.map((x) => ({ step: x.index, who: ROLE[x.turn.role] ?? x.turn.role, text: turnText(x.turn), broke_here: x.hit })),
    })),
    must_not_regress: e.others.filter((o) => o.verdict === "holds").map((o) => ({ id: o.rule.id, title: o.rule.title })),
    verify: `tripwire eval ${project} --cases ${e.tests.map((t) => t.id).join(" ")} -k ${e.run?.config.k ?? 3}`,
  };
}

/** A self-contained brief an agent (or a colleague) can act on without opening tripwire. */
export function briefMarkdown(e: Evidence, project: string): string {
  const j = briefJSON(e, project);
  const L: string[] = [];
  L.push(`# Fix brief: ${e.rule.id} "${e.rule.title}" (${project})`, "");
  if (j.run) L.push(`Check: ${j.run}${j.models ? ` · agent ${j.models.agent}` : ""}`, "");
  L.push("## The promise", "", e.rule.text, "");
  if (j.verdict) L.push(`Verdict: **${j.verdict.verdict}**. ${j.verdict.summary}.`, "");
  if (j.prompt_part) L.push(`## The prompt part it comes from: "${j.prompt_part.name}"`, "", ...String(j.prompt_part.text).split("\n").map((l) => `> ${l}`), "");
  if (j.map) L.push("## Map evidence", "", `With "${j.map.part}" it broke ${j.map.with_part}; without it ${j.map.without_part} (${j.map.role}).`, "");
  if (j.failures.length) {
    L.push(`## Where it broke (${j.failures.length})`, "");
    for (const f of j.failures) {
      const t = f.test as { id: string; title?: string; kind?: string; angle?: string; customer?: string };
      L.push(`### Test ${t.id}${t.title ? ` "${t.title}"` : ""}${t.kind ? ` (${t.kind}${t.angle ? `, ${t.angle}` : ""})` : ""}, try ${f.try}${f.step !== null ? `, step ${f.step}` : ""}`);
      if (t.customer) L.push(`Customer: ${t.customer}`);
      for (const c of f.checks) L.push(`Failed check: \`${c.check}\`: ${c.why}`);
      L.push("");
      for (const x of f.excerpt) L.push(`- **${x.who}** (step ${x.step})${x.broke_here ? " ← broke here" : ""}: ${x.text}`);
      L.push("");
    }
  }
  if (j.must_not_regress.length) L.push("## Must not regress", "", ...j.must_not_regress.map((r) => `- ${r.id} ${r.title}`), "");
  L.push("## Verify", "", "```", j.verify, "```", "");
  return L.join("\n");
}
