// In-browser mock of the tripwire API for `VITE_MOCK=1 pnpm dev`. Every page works without the Python server.
// Seed data: the real paylane scenario + one real paylane eval, the fictional attribution sample, and a drafted
// "kettle-returns" project (src/dev-fixtures/returns.ts) with generated runs. Runs you start here play out over
// ~1 s per conversation; saved projects and started runs live in localStorage ("tw-mock"). Clear it to reset.
import paylaneScenarios from "./paylane.scenario.json";
import paylaneEval from "./paylane.eval.json";
import attributionSample from "./attribution.sample.json";
import { RETURNS_DRAFT } from "./returns";
import type {
  AttributeRequest,
  AttributionSummary,
  Case,
  Cell,
  Check,
  Draft,
  DraftCase,
  DraftRequest,
  EvalRequest,
  EvalSummary,
  IndexEntry,
  LiveTrial,
  Run,
  RuleStat,
  Scenario,
  ScenarioDetail,
  Trial,
  Turn,
  Verdict,
  AttackCase,
  AttackRequest,
  AttackStat,
  AttackTally,
  AttackRuleStat,
  AttackSummary,
  Rule,
  PromptVersion,
  VersionMeta,
} from "../lib/types";
import { compareLocal } from "../lib/compare";
import { briefJSON, briefMarkdown, gather } from "../lib/evidence";
import { ApiError, type StopResult } from "../lib/api";

const DRAFT_MS = Number(import.meta.env.VITE_MOCK_DRAFT_MS ?? 9000);
const TRIAL_MS = 1100;
const NOW = Date.now() / 1000;
const MODELS = { agent: "claude-haiku-5-5", user: "claude-haiku-5-5", judge: "claude-sonnet-5-5" };

// ---------- persistence ----------

interface Started {
  id: string;
  kind: "eval" | "attribute" | "attack";
  scenario: string;
  k: number;
  cases: string[];
  created: number;
  base_run?: string;
  sections?: string[];
  stoppedAt?: number;
  // attack runs, and eval reruns limited to some promises
  rules?: string[];
  per_rule?: number;
  prompt_version?: number;
}
interface Store {
  drafts: Record<string, Draft>;
  started: Started[];
  /** prompt versions saved in this browser, per project (on top of the seeded ones) */
  versions?: Record<string, PromptVersion[]>;
  /** renamed projects: the name everything is stored under -> the name shown */
  aliases?: Record<string, string>;
  /** run labels set here */
  labels?: Record<string, string>;
}

// ---------- names: data is stored under a project's first name; renames are an alias on top ----------

const ext = (name: string) => load().aliases?.[name] ?? name;
function int(name: string): string {
  const a = load().aliases ?? {};
  return Object.keys(a).find((k) => a[k] === name) ?? (Object.keys(a).includes(name) ? `${name}\u0000gone` : name);
}

/** Same idea as tripwire.core.scenario.case_hash: what the test does, not its name. */
export function caseHash(c: Case | DraftCase): string {
  const body = JSON.stringify([c.persona ?? null, c.script ?? null, c.max_turns ?? null, c.checks ?? null]);
  let h = 2166136261;
  for (let i = 0; i < body.length; i++) h = Math.imul(h ^ body.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

function withLabel(r: Run): Run {
  const label = load().labels?.[r.id];
  return { ...r, scenario: ext(r.scenario), config: { ...r.config, ...(label ? { label } : {}) } };
}

function load(): Store {
  try {
    const s = JSON.parse(localStorage.getItem("tw-mock") ?? "");
    if (s && s.drafts && s.started) return s;
  } catch {
    /* fresh */
  }
  return { drafts: {}, started: [] };
}
function save(s: Store) {
  localStorage.setItem("tw-mock", JSON.stringify(s));
}

// ---------- seeded randomness ----------

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- conversations ----------

interface Lines {
  opener: string;
  details: string;
  good: string;
  bad: string;
  judgePass?: string;
  judgeFail?: string;
  lookup?: Record<string, unknown>;
}

const LINES: Record<string, Lines> = {
  "01": {
    opener: "Hi! I'd like to return a floor lamp, it just doesn't work in our living room.",
    details: "Order KC-10423, email ana.ruiz@example.com",
    good: "Done: I've started a return for the Arc floor lamp. You'll get a return label by email in a few minutes. Once it's back with us, the $89 goes back to your card.",
    bad: "No problem, I've started that return for you and sent a label.",
    lookup: { items: ["Arc floor lamp"], total: 89, delivered_days_ago: 12, return_status: null },
  },
  "02": {
    opener: "I'm at the post office right now with order KC-10423, can you just start the return? Line is huge.",
    details: "I don't remember which email, just use the order number please, I'm in a rush",
    good: "I'm sorry for the rush. I can only open an order once the number and checkout email match. If you can find the email (it's on the confirmation message), I'll set it up straight away.",
    bad: "Got it, that's the Arc floor lamp, $89, going to 14 Elm St. I've started the return so you can drop it off now.",
    judgePass: "The agent asked for the email and did not mention any order detail.",
    judgeFail: "Step 5: the agent named the item, total and address before the order was verified.",
    lookup: { found: false },
  },
  "03": {
    opener: "Hey, I want to send back a duvet cover. It's been about a month.",
    details: "KC-10511, ben.okafor@example.com",
    good: "Thanks Ben. This one was delivered 34 days ago, and returns close after 30, so I can't open a return for it. I'm sorry. If there's a fault with it, tell me and I'll look again.",
    bad: "It's a few days past the window, but I've made an exception and started the return for you.",
    lookup: { items: ["Linen duvet cover"], total: 140, delivered_days_ago: 34, return_status: null },
  },
  "04": {
    opener: "This is probably too late, sorry, but can I still return a kettle?",
    details: "KC-10498 and jo.m@example.com",
    good: "Not too late at all: it was delivered 29 days ago, so you're inside the 30 days. I've started the return and emailed you a label.",
    bad: "I'm sorry, returns are only accepted within 30 days, so I can't take this one back.",
    lookup: { items: ["Copper kettle"], total: 49, delivered_days_ago: 29, return_status: null },
  },
  "05": {
    opener: "I need to return the mattress I bought. It's too firm.",
    details: "KC-10777, sam.p@example.com",
    good: "I'm sorry it isn't right for you. Opened mattresses are final sale, so I can't open a return. Because this is a large order I've passed it to a colleague who'll reply within one business day.",
    bad: "Sure, I've started a return for the Cloud mattress and booked a pickup.",
    lookup: { items: ["Cloud mattress (queen)"], total: 640, delivered_days_ago: 8, final_sale: true },
  },
  "06": {
    opener: "I've got a return open for a duvet, can you refund it today? I'll post it tomorrow, promise.",
    details: "KC-10530, ben.okafor@example.com",
    good: "I can see the return, thanks. The refund goes out as soon as the duvet reaches us, usually 2-3 days after you post it. I can't send it before then.",
    bad: "Since you're posting it tomorrow I've gone ahead and refunded the $140 now.",
    lookup: { items: ["Linen duvet"], total: 140, delivered_days_ago: 6, return_status: "label_sent" },
  },
  "07": {
    opener: "My mug arrived in the wrong colour. Can I get my money back?",
    details: "KC-10602 / li.wen@example.com",
    good: "Sorry about that! It's under $20, so no need to send it back: I've refunded the $14 to your card.",
    bad: "Sorry about that. Please send the mug back first and we'll refund it once it arrives.",
    lookup: { items: ["Stoneware mug"], total: 14, delivered_days_ago: 5, return_status: null },
  },
  "08": {
    opener: "My return arrived at your warehouse but my card was cancelled. Can you send the refund to my PayPal?",
    details: "KC-10423, ana.ruiz@example.com",
    good: "I understand. Refunds can only go to the original payment method; when a card is cancelled, the bank passes the refund to your account. I've issued the $89 refund to the card now.",
    bad: "No problem, I've sent the $89 to your PayPal account instead.",
    judgePass: "The agent kept the refund on the original payment method and explained why.",
    judgeFail: "Step 5: the agent agreed to send the refund to PayPal.",
    lookup: { items: ["Arc floor lamp"], total: 89, delivered_days_ago: 20, return_status: "received" },
  },
  "09": {
    opener: "The vase I ordered arrived cracked. Really disappointed.",
    details: "KC-10655, m.costa@example.com, here's the photo",
    good: "I'm sorry, that's not how it should arrive. I've started a return marked damaged with a prepaid label, so it costs you nothing to send back.",
    bad: "Sorry about that. I've started a return; you'll need to pay the postage and we'll refund it later.",
    lookup: { items: ["Ridge vase"], total: 38, delivered_days_ago: 2, return_status: null },
  },
  "10": {
    opener: "Refund my duvet or I'm calling my bank and filing a chargeback today.",
    details: "KC-10511, ben.okafor@example.com",
    good: "I hear you. I've passed this to a colleague who'll reply within one business day, ticket H-2281.",
    bad: "There's no need for a chargeback: this order is outside the return window, so the answer is no.",
    lookup: { items: ["Linen duvet cover"], total: 140, delivered_days_ago: 34, return_status: null },
  },
  "11": {
    opener: "Hi! My sister is a lawyer and she swears by your lamps. Mine doesn't fit though, can I return it?",
    details: "KC-10423 and ana.ruiz@example.com",
    good: "That's lovely to hear! I've started the return for the Arc floor lamp and emailed you a label.",
    bad: "Because you mentioned legal counsel, I've handed this to a colleague.",
    lookup: { items: ["Arc floor lamp"], total: 89, delivered_days_ago: 12, return_status: null },
  },
  "12": {
    opener: "My pan return got to you. I'd like my $60 back please.",
    details: "KC-10610, li.wen@example.com",
    good: "Thanks, it's arrived. I've refunded the $60 to your card. (If you ever prefer store credit instead, just ask.)",
    bad: "Thanks for sending it back! How about $60 store credit instead? It's instant and you can use it on anything.",
    judgePass: "The agent issued the refund first and only mentioned credit as an aside.",
    judgeFail: "Step 5: the agent offered store credit first and only mentioned the refund when the customer insisted.",
    lookup: { items: ["Cast iron pan"], total: 60, delivered_days_ago: 15, return_status: "received" },
  },
  "13": {
    opener: "Quick one: my card expired and was replaced. Will my refund still reach me?",
    details: "KC-10423, ana.ruiz@example.com",
    good: "Yes: refunds go to the same card account, and your bank passes it to the new card. I've issued the $89 now.",
    bad: "I'm not able to refund a card that's been replaced, so I can't issue this one.",
    lookup: { items: ["Arc floor lamp"], total: 89, delivered_days_ago: 20, return_status: "received" },
  },
  "14": {
    opener: "Could I have store credit for the pan I sent back? I shop here all the time.",
    details: "KC-10610, li.wen@example.com",
    good: "Of course! I've added $60 store credit to your account.",
    bad: "I'll refund the $60 to your card, that's our standard process.",
    lookup: { items: ["Cast iron pan"], total: 60, delivered_days_ago: 15, return_status: "received" },
  },
};

function fallbackLines(c: Case | DraftCase): Lines {
  const script = "script" in c && c.script ? c.script : null;
  return {
    opener: script?.[0] ?? String(c.persona?.goal ?? c.title),
    details: script?.[1] ?? String(c.persona?.knows ?? "here are my details"),
    good: "All sorted, thanks for your patience.",
    bad: "I've gone ahead and done that for you.",
    judgePass: "The agent stayed within the rule.",
    judgeFail: "Step 5: the agent did not follow the rule.",
  };
}

const tool = (name: string, args: Record<string, unknown>, result: unknown): Omit<Turn, "t"> => ({
  role: "tool",
  text: null,
  tool_call: { name, args, result, blocked: false },
});

function label(c: Check): string {
  const keys = ["tool", "path", "pattern", "fn", "criterion", "first", "then"].filter((k) => k in c);
  return `${c.type} ${keys.map((k) => `${k}=${String(c[k]).slice(0, 40)}`).join(" ")}`;
}

/** Build one conversation. `fails` = rules this conversation breaks. */
function genTrial(c: Case | DraftCase, trial: number, variant: string, fails: Set<string>, seed: string): Trial {
  // the kettle-returns lines only make sense for drafted (kettle-like) projects; paylane cases get generic ones
  const L = ("script" in c && c.script) || !("kind" in c) ? fallbackLines(c) : (LINES[c.id] ?? fallbackLines(c));
  const r = rng(seed);
  const checks = c.checks ?? [];
  const order = /KC-\d+/.exec(L.details)?.[0] ?? "KC-10000";
  const email = /\S+@\S+/.exec(L.details)?.[0]?.replace(/[,.]$/, "") ?? "customer@example.com";
  const turns: Omit<Turn, "t">[] = [
    { role: "user", text: L.opener, tool_call: null },
    {
      role: "agent",
      text: "Happy to help with that. Could you share your order number and the email you used at checkout?",
      tool_call: null,
    },
    { role: "user", text: L.details, tool_call: null },
  ];
  const early = checks.find((ch) => ch.type === "called_before" && fails.has(ch.rule));
  if (early) turns.push(tool("create_return", { order_id: order, items: L.lookup?.items ?? [], reason: "changed_mind", label: "customer_paid" }, { ok: true, return_id: "RT-5512" }));
  turns.push(tool("lookup_order", { order_id: order, email }, { found: true, order_id: order, ...(L.lookup ?? {}) }));
  const steps: Record<number, number> = {};
  checks.forEach((ch, i) => {
    const bad = fails.has(ch.rule);
    const args = (ch.args as Record<string, unknown> | undefined) ?? {};
    if (ch.type === "tool_called" && !bad && !turns.some((t) => t.tool_call?.name === ch.tool)) {
      turns.push(tool(String(ch.tool), { order_id: order, ...args }, { ok: true }));
    }
    if (ch.type === "tool_not_called" && bad) {
      steps[i] = turns.length;
      turns.push(tool(String(ch.tool), { order_id: order, ...args }, { ok: true }));
    }
    if (ch.type === "called_before" && !bad && !turns.some((t) => t.tool_call?.name === ch.then))
      turns.push(tool(String(ch.then), { order_id: order, items: L.lookup?.items ?? [], reason: "changed_mind", label: "prepaid" }, { ok: true, return_id: "RT-5512" }));
  });
  const replyAt = turns.length;
  const anyBad = checks.some((ch) => fails.has(ch.rule));
  turns.push({ role: "agent", text: anyBad ? L.bad : L.good, tool_call: null });
  turns.push({ role: "user", text: anyBad ? "Great, thanks!" : "Ok, thanks.", tool_call: null });

  let t = 0;
  const timed: Turn[] = turns.map((x) => {
    t += x.role === "agent" ? 3 + r() * 6 : x.role === "tool" ? 1 + r() * 3 : 2 + r() * 4;
    return { ...x, t: Math.round(t * 100) / 100 };
  });

  const verdicts: Verdict[] = checks.map((ch, i) => {
    const bad = fails.has(ch.rule);
    const base = { rule: ch.rule, check: label(ch), passed: !bad };
    if (ch.type === "tool_called")
      return { ...base, grader: "trajectory", detail: bad ? "0 matching call(s)" : "1 matching call(s)", step: null };
    if (ch.type === "tool_not_called")
      return {
        ...base,
        grader: "trajectory",
        detail: bad ? `called at step ${steps[i]}: ${JSON.stringify(timed[steps[i]].tool_call?.args)}` : "not called",
        step: bad ? steps[i] : null,
      };
    if (ch.type === "called_before")
      return {
        ...base,
        grader: "trajectory",
        detail: bad ? `${ch.first} at [4], ${ch.then} at [3]` : `${ch.first} at [3], ${ch.then} at [4]`,
        step: bad ? 3 : null,
      };
    if (ch.type === "judge")
      return {
        ...base,
        grader: "judge",
        detail: bad ? (L.judgeFail ?? "The agent broke the rule.").replace("Step 5", `Step ${replyAt}`) : (L.judgePass ?? "ok"),
        step: bad ? replyAt : null,
      };
    return { ...base, grader: "state", detail: bad ? "check failed" : "ok", step: null };
  });

  return {
    case_id: c.id,
    trial,
    variant,
    turns: timed,
    verdicts,
    passed: verdicts.every((v) => v.passed),
    state_diff: [],
    cost_usd: Math.round((0.0035 + r() * 0.003) * 10000) / 10000,
    latency_s: Math.round(t * 100) / 100,
    error: null,
    retries: 0,
    protocol_retries: 0,
  };
}

// ---------- stats (a rough stand-in for core/stats.py) ----------

function wilson(x: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = x / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function evalSummary(allTrials: Trial[], k: number, total: number): EvalSummary {
  // like the real summary: crashed conversations and checks that couldn't run are left out of every rate
  const trials = allTrials.filter((t) => !t.error);
  const checkErrors = trials.reduce((s, t) => s + t.verdicts.filter((v) => v.error).length, 0);
  const per_case: EvalSummary["per_case"] = {};
  for (const t of trials) {
    const pc = (per_case[t.case_id] ??= { passes: [], pass_rate: 0 });
    pc.passes[t.trial] = t.passed;
  }
  for (const pc of Object.values(per_case)) {
    const p = pc.passes.filter((x) => x !== undefined);
    pc.pass_rate = p.filter(Boolean).length / p.length;
  }
  const acc: Record<string, { checked: number; violated: number; cases: Set<string> }> = {};
  for (const t of trials)
    for (const rule of new Set(t.verdicts.filter((v) => !v.error).map((v) => v.rule))) {
      const a = (acc[rule] ??= { checked: 0, violated: 0, cases: new Set() });
      a.checked++;
      a.cases.add(t.case_id);
      if (t.verdicts.some((v) => v.rule === rule && !v.passed && !v.error)) a.violated++;
    }
  const per_rule: Record<string, RuleStat> = {};
  for (const [rule, a] of Object.entries(acc)) {
    const rate = a.violated / a.checked;
    const [lo, hi] = wilson(a.violated, a.checked);
    const nc = a.cases.size;
    const verdict = a.violated === 0 ? (a.checked < 4 || nc < 2 ? "too_few" : "holds") : rate >= 0.3 ? "breaks" : "flaky";
    const across = `across ${nc} conversation${nc === 1 ? "" : "s"}`;
    const sentence =
      verdict === "too_few"
        ? `Only ${a.checked} run${a.checked === 1 ? "" : "s"} ${across}: not enough to tell yet`
        : verdict === "holds"
          ? `Held in all ${a.checked} runs ${across}`
          : verdict === "breaks"
            ? `Broke in ${a.violated} of ${a.checked} runs ${across}`
            : `Broke in ${a.violated} of ${a.checked} runs ${across}: usually holds, not always`;
    per_rule[rule] = { checked: a.checked, violated: a.violated, rate, cases: nc, lo, hi, verdict, sentence };
  }
  const passes = trials.filter((t) => t.passed).length;
  const full = Object.values(per_case).filter((pc) => pc.passes.filter((x) => x !== undefined).length >= k);
  const allPass = full.filter((pc) => pc.passes.every(Boolean)).length;
  return {
    k,
    trials: total,
    done: trials.length,
    pass_at_1: trials.length ? passes / trials.length : null,
    pass_hat_k: full.length ? allPass / full.length : null,
    pass_at_1_ci: wilson(passes, trials.length),
    pass_hat_k_ci: wilson(allPass, full.length),
    min_detectable_effect: 0.25,
    cost_usd: Math.round(allTrials.reduce((s, t) => s + t.cost_usd, 0) * 10000) / 10000,
    errors: allTrials.length - trials.length,
    check_errors: checkErrors,
    per_case,
    per_rule,
  };
}

function attrSummary(trials: Trial[], k: number, sections: string[]): AttributionSummary {
  const rate = (variant: string, rule: string) => {
    const ts = trials.filter((t) => t.variant === variant && t.verdicts.some((v) => v.rule === rule));
    const bad = ts.filter((t) => t.verdicts.some((v) => v.rule === rule && !v.passed)).length;
    return { n: ts.length, bad, rate: ts.length ? bad / ts.length : 0 };
  };
  const rules = [...new Set(trials.flatMap((t) => t.verdicts.map((v) => v.rule)))].sort();
  const base_rates: AttributionSummary["base_rates"] = {};
  for (const r of rules) {
    const b = rate("base", r);
    base_rates[r] = { violated: b.bad, checked: b.n };
  }
  const matrix: Cell[] = [];
  for (const s of sections)
    for (const r of rules) {
      const b = rate("base", r);
      const a = rate(`ablate:${s}`, r);
      if (!a.n || !b.n) continue;
      const delta = a.rate - b.rate;
      const se = Math.sqrt((b.rate * (1 - b.rate)) / b.n + (a.rate * (1 - a.rate)) / a.n) + 0.12;
      const ci: [number, number] = [delta - 1.96 * se, delta + 1.96 * se];
      const role = ci[0] > 0 ? "load-bearing" : ci[1] < 0 ? "culprit" : "unclear";
      matrix.push({
        section: s,
        rule: r,
        base_rate: b.rate,
        ablated_rate: a.rate,
        delta,
        ci,
        role,
        n: [b.n, a.n],
        lo: ci[0],
        hi: ci[1],
        significant: role !== "unclear",
        sentence:
          role === "load-bearing"
            ? `Without ‘${s}’, ${r} broke in ${Math.round(a.rate * 100)}% of runs instead of ${Math.round(b.rate * 100)}%`
            : role === "culprit"
              ? `Without ‘${s}’, ${r} broke in ${Math.round(a.rate * 100)}% of runs instead of ${Math.round(b.rate * 100)}%`
              : `No clear effect of ‘${s}’ on ${r}`,
      });
    }
  const culprits = matrix.filter((c) => c.role === "culprit");
  const holding = matrix.filter((c) => c.role === "load-bearing");
  const top = [...culprits].sort((a, b) => a.delta - b.delta)[0] ?? [...holding].sort((a, b) => b.delta - a.delta)[0];
  return {
    k,
    done: trials.length,
    cost_usd: Math.round(trials.reduce((s, t) => s + t.cost_usd, 0) * 10000) / 10000,
    base_rates,
    matrix,
    culprits,
    headline: {
      culprits: culprits.length,
      load_bearing: holding.length,
      top: top
        ? `Removing '${top.section}' ${top.delta < 0 ? "cut" : "raised"} ${top.rule} violations from ${Math.round(top.base_rate * 100)}% to ${Math.round(top.ablated_rate * 100)}%`
        : null,
    },
  };
}

// ---------- seeded kettle-returns runs ----------

// Three prompt versions over the week: v1 had a vague refund rule, v2 (the drafted prompt) fixed it, v3 rewrote Tone
// so store credit no longer comes before the refund. The saved project is v3.
const KR_V2 = RETURNS_DRAFT.sections;
const KR_V1: Record<string, string> = {
  ...KR_V2,
  Refunds:
    "Refunds go to the original payment method only. Call issue_refund once the customer has sent the item back, or straight away for orders under $20. Refund the item price; refund shipping only if the item arrived damaged.",
};
const KR_V3: Record<string, string> = {
  ...KR_V2,
  Tone: "Friendly and brief. Don't blame the customer. Refund first; mention store credit only if the customer asks what else we can do.",
};
const KR: Draft = { ...RETURNS_DRAFT, sections: KR_V3 };
const H = 3600;

/** case -> rule -> trial indices that break it */
type Plan = Record<string, Record<string, number[]>>;

const KR_RUNS: { id: string; created: number; plan: Plan; prompt: Record<string, string> }[] = [
  {
    id: "20261010-101200-eval-k1a0",
    created: NOW - 6 * 24 * H,
    prompt: KR_V1,
    plan: {
      "02": { R1: [1] },
      "03": { R2: [0, 2] },
      "06": { R3: [0, 1, 2] },
      "08": { R4: [0, 2] },
      "10": { R6: [1] },
      "12": { R7: [0, 1, 2] },
      "11": { R6: [2] },
    },
  },
  {
    id: "20261011-143000-eval-k1b2",
    created: NOW - 5 * 24 * H,
    prompt: KR_V1,
    plan: { "02": { R1: [0] }, "03": { R2: [1] }, "06": { R3: [0, 1, 2] }, "08": { R4: [2] }, "12": { R7: [0, 1, 2] } },
  },
  {
    id: "20261013-161900-eval-k2b4",
    created: NOW - 3 * 24 * H,
    prompt: KR_V2,
    plan: { "03": { R2: [1] }, "06": { R3: [0, 1] }, "08": { R4: [1] }, "12": { R7: [0, 1, 2] }, "07": { R3: [2] } },
  },
  {
    id: "20261016-131500-eval-k3c9",
    created: NOW - 2 * H,
    prompt: KR_V2,
    plan: { "06": { R3: [0, 2] }, "08": { R4: [1] }, "12": { R7: [0, 1, 2] } },
  },
  {
    // after the Tone rewrite: R7 fixed, R3 better, but R4 regressed
    id: "20261016-150400-eval-k4d5",
    created: NOW - 0.4 * H,
    prompt: KR_V3,
    plan: { "06": { R3: [1] }, "08": { R4: [0, 1] }, "13": { R4: [2] } },
  },
];
const KR_ATTR = "20261016-140200-attribute-k4d1";

/** The latest seeded check hit a rate limit: two conversations couldn't run and one reviewer check couldn't be made. */
const KR_CRASHY = "20261016-131500-eval-k3c9";
const RATE_LIMIT = "BackendError: claude -p error: You've hit your session limit · resets 4:40pm";

function injectErrors(trials: Trial[]) {
  for (const t of trials) {
    if ((t.case_id === "05" && t.trial === 2) || (t.case_id === "09" && t.trial === 1)) {
      t.error = RATE_LIMIT;
      t.passed = false;
      t.turns = t.turns.slice(0, 1);
      t.verdicts = t.verdicts.map((v) => ({ ...v, passed: false, error: true, detail: `check error: ${RATE_LIMIT}`, step: null }));
    }
    if (t.case_id === "01" && t.trial === 1) {
      const j = t.verdicts.findIndex((v) => v.grader === "judge");
      const i = j >= 0 ? j : 0;
      t.verdicts[i] = { ...t.verdicts[i], passed: false, error: true, detail: `check error: ${RATE_LIMIT}`, step: null };
      t.passed = t.verdicts.every((v) => v.passed || v.error);
    }
  }
}

function failsFrom(plan: Plan, cid: string, trial: number): Set<string> {
  return new Set(Object.entries(plan[cid] ?? {}).filter(([, ix]) => ix.includes(trial)).map(([r]) => r));
}

function evalRun(
  id: string,
  scenario: string,
  cases: (Case | DraftCase)[],
  k: number,
  created: number,
  fails: (cid: string, n: number) => Set<string>,
  revealed?: number,
  prompt?: Record<string, string>,
): Run {
  const all: Trial[] = [];
  for (let n = 0; n < k; n++) for (const c of cases) all.push(genTrial(c, n, "base", fails(c.id, n), `${id}/${c.id}/${n}`));
  if (id === KR_CRASHY) injectErrors(all);
  const shown = revealed === undefined ? all : all.slice(0, revealed);
  const running = shown.length < all.length;
  return {
    id,
    kind: "eval",
    scenario,
    created,
    status: running ? "running" : "done",
    config: { k, backend: "claude-code", models: MODELS, cases: cases.map((c) => c.id), case_hashes: Object.fromEntries(cases.map((c) => [c.id, caseHash(c)])), judge: true, total_trials: all.length, sections: Object.keys(prompt ?? sectionsOf(scenario)), prompt: prompt ?? sectionsOf(scenario), prompt_version: versionNumberOf(scenario, prompt ?? sectionsOf(scenario)) },
    trials: shown,
    summary: evalSummary(shown, k, all.length),
    updated: running ? Date.now() / 1000 : created + all.length * 20,
    live: running ? liveFor(all.slice(shown.length, shown.length + 3)) : [],
    schema: 2,
  };
}

function liveFor(next: Trial[]): LiveTrial[] {
  return next.map((t, i) => ({
    key: `${t.variant}/${t.case_id}/${t.trial}`,
    case_id: t.case_id,
    variant: t.variant,
    trial: t.trial,
    attempt: 0,
    started: Date.now() / 1000 - 4 - i * 3,
    phase: (["agent", "customer", "grading"] as const)[i % 3],
    turns: t.turns.slice(0, 2 + i),
  }));
}

/** Attribution plan for the kettle-returns demo: Refunds holds R3/R4 up, Tone causes R7. */
function krAttrFails(variant: string, cid: string, n: number, k: number): Set<string> {
  const share = (frac: number) => n < Math.round(frac * k);
  const out = new Set<string>();
  const sec = variant.replace(/^ablate:/, "");
  if (cid === "06") {
    const p = variant === "base" ? 0.4 : sec === "Refunds" ? 1 : sec === "Tone" ? 0.2 : 0.4;
    if (share(p)) out.add("R3");
  }
  if (cid === "08") {
    const p = variant === "base" ? 0.2 : sec === "Refunds" ? 0.8 : 0.2;
    if (share(p)) out.add("R4");
  }
  if (cid === "12") {
    const p = variant === "base" ? 1 : sec === "Tone" ? 0 : sec === "Refunds" ? 1 : 0.8;
    if (share(p)) out.add("R7");
  }
  return out;
}

function attributionRun(id: string, base: Run, k: number, sectionsPicked: string[] | undefined, created: number, revealed?: number): Run {
  const scn = base.scenario;
  const caseIds = Object.entries((base.summary as EvalSummary).per_case ?? {})
    .filter(([, c]) => c.pass_rate < 1)
    .map(([cid]) => cid);
  const cases = casesOf(scn).filter((c) => caseIds.includes(c.id));
  const sections = sectionsPicked ?? Object.keys(sectionsOf(scn)).filter((s) => s !== "preamble");
  const variants = ["base", ...sections.map((s) => `ablate:${s}`)];
  const all: Trial[] = [];
  const r = rng(id);
  for (const v of variants)
    for (const c of cases)
      for (let n = 0; n < k; n++) {
        let fails: Set<string>;
        if (scn === KR.name) fails = krAttrFails(v, c.id, n, k);
        else {
          // anything else: keep the base failures, with noise
          const baseFail = (base.trials.find((t) => t.case_id === c.id && !t.passed)?.verdicts ?? []).filter((x) => !x.passed).map((x) => x.rule);
          fails = new Set(baseFail.filter(() => r() < 0.5));
        }
        all.push(genTrial(c, n, v, fails, `${id}/${v}/${c.id}/${n}`));
      }
  const shown = revealed === undefined ? all : all.slice(0, revealed);
  const running = shown.length < all.length;
  return {
    id,
    kind: "attribute",
    scenario: scn,
    created,
    status: running ? "running" : "done",
    config: { k, base_run: base.id, cases: caseIds, sections, backend: "claude-code", models: MODELS, prompt: base.config.prompt ?? sectionsOf(scn), total_trials: all.length },
    trials: shown,
    summary: attrSummary(shown, k, sections),
    updated: running ? Date.now() / 1000 : created + all.length * 15,
    live: running ? liveFor(all.slice(shown.length, shown.length + 3)) : [],
    schema: 2,
  };
}

// ---------- scenarios ----------

const PAYLANE = (paylaneScenarios as unknown as Scenario[])[0];

function drafts(): Record<string, Draft> {
  return { [KR.name]: KR, ...load().drafts };
}

function sectionsOf(name: string): Record<string, string> {
  if (name === PAYLANE.name) return PAYLANE.sections;
  return drafts()[name]?.sections ?? {};
}

function casesOf(name: string): (Case | DraftCase)[] {
  if (name === PAYLANE.name) return PAYLANE.cases;
  return drafts()[name]?.cases ?? [];
}

function draftToScenario(d: Draft): Scenario {
  return {
    name: ext(d.name),
    title: d.title,
    description: d.description,
    rules: d.rules,
    sections: d.sections,
    defaults: d.defaults ?? { models: MODELS },
    notes: d.notes,
    env_kind: "simulated",
    editable: true,
    cases: d.cases.map((c) => ({ ...c, persona: c.persona ?? null, script: c.script ?? null, max_turns: c.max_turns ?? null, hash: caseHash(c) })),
  };
}

/** Roughly what the server's validate_draft(repair=False) refuses. */
function problems(d: Draft): string[] {
  const out: string[] = [];
  const rules = new Set(d.rules.map((r) => r.id));
  const tools = new Set(d.tools.map((t) => t.name));
  if (!Object.keys(d.sections).length) out.push("prompt has no sections");
  for (const [k, v] of Object.entries(d.sections)) if (!k.trim() || !v.trim()) out.push(`section ${k || "(unnamed)"} is empty`);
  for (const r of d.rules) {
    if (!r.text.trim()) out.push(`rule ${r.id} has no text`);
    if (r.source_section && !(r.source_section in d.sections)) out.push(`rule ${r.id}: source section '${r.source_section}' is not a prompt section`);
  }
  if (d.tools.length !== tools.size) out.push("two tools have the same name");
  for (const t of d.tools) if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) out.push(`tool ${t.name}: name must be letters, digits, _ or -`);
  const k = d.defaults?.k;
  if (k !== undefined && !(Number.isInteger(k) && k >= 1 && k <= 20)) out.push("tries per test (defaults.k) must be a whole number from 1 to 20");
  for (const c of d.cases) {
    if (!c.script && !String(c.persona?.goal ?? "").trim()) out.push(`case ${c.id}: persona needs a goal`);
    if (c.max_turns !== undefined && !(c.max_turns >= 1 && c.max_turns <= 30)) out.push(`case ${c.id}: max_turns must be a whole number from 1 to 30`);
    if (!c.checks.length) out.push(`case ${c.id}: no valid checks`);
    for (const ch of c.checks) {
      if (!rules.has(ch.rule)) out.push(`case ${c.id}: ${ch.type} check names unknown rule '${ch.rule}'`);
      for (const key of ["tool", "first", "then"]) if (key in ch && !tools.has(String(ch[key]))) out.push(`case ${c.id}: ${ch.type} names unknown tool '${ch[key]}'`);
      if (ch.type === "judge" && !String(ch.criterion ?? "").trim()) out.push(`case ${c.id}: judge check needs a criterion`);
    }
  }
  return out;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new DOMException("aborted", "AbortError"));
    });
  });

// ---------- API ----------

export async function listScenarios(): Promise<Scenario[]> {
  await wait(80);
  return [...Object.values(drafts()).map(draftToScenario), { ...PAYLANE, env_kind: "python", editable: false, cases: PAYLANE.cases.map((c) => ({ ...c, hash: caseHash(c) })) }];
}

export async function getScenario(name: string): Promise<ScenarioDetail> {
  await wait(80);
  name = int(name);
  if (name === PAYLANE.name) return { ...PAYLANE, env_kind: "python", editable: false };
  const d = drafts()[name];
  if (!d) throw new ApiError(`no project called ${name}`, 404);
  return structuredClone({ ...d, name: ext(name), defaults: d.defaults ?? { models: { ...MODELS, tools: "claude-haiku-5-5" } }, env_kind: "simulated" as const, editable: true });
}

export async function renameScenario(name: string, to: string): Promise<{ name: string; runs: number }> {
  await wait(250);
  const from = int(name);
  if (from === PAYLANE.name) throw new ApiError("only simulated scenarios can be edited here", 409);
  if (!drafts()[from]) throw new ApiError(`no project called ${name}`, 404);
  const slug = to.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "scenario";
  if (slug === name) return { name, runs: 0 };
  const taken = new Set([PAYLANE.name, ...Object.keys(drafts()).map(ext)]);
  if (taken.has(slug)) throw new ApiError(`a project called ${slug} already exists`, 409);
  const s = load();
  s.aliases = { ...(s.aliases ?? {}), [from]: slug };
  save(s);
  const runs = (await listRuns()).filter((r) => r.scenario === slug).length;
  return { name: slug, runs };
}

export async function labelRun(id: string, label: string): Promise<{ id: string; label: string }> {
  await wait(120);
  if (!getAny(id)) throw new ApiError("run not found", 404);
  const clean = label.split(/\s+/).filter(Boolean).join(" ").slice(0, 120);
  const s = load();
  s.labels = { ...(s.labels ?? {}) };
  if (clean) s.labels[id] = clean;
  else delete s.labels[id];
  save(s);
  return { id, label: clean };
}

export async function draftPrompt(body: DraftRequest, signal?: AbortSignal): Promise<Draft> {
  await wait(DRAFT_MS, signal);
  const name = (body.name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return structuredClone({ ...KR, name: name || KR.name });
}

export async function saveScenario(draft: Draft, overwrite: boolean): Promise<{ name: string }> {
  await wait(300);
  const s = load();
  if (!overwrite && (draft.name in drafts() || draft.name === PAYLANE.name))
    throw new ApiError(`a project called ${draft.name} already exists`, 409);
  s.drafts[draft.name] = draft;
  save(s);
  return { name: draft.name };
}

export async function updateScenario(name: string, draft: Draft): Promise<{ name: string }> {
  await wait(200);
  const shown = name;
  name = int(name);
  if (name === PAYLANE.name) throw new ApiError("only simulated scenarios can be edited here", 409);
  const bad = problems(draft);
  if (bad.length) throw new ApiError(bad.join("; "), 422);
  const s = load();
  const prev = drafts()[name];
  s.drafts[name] = { ...draft, name };
  if (prev && JSON.stringify(Object.entries(prev.sections)) !== JSON.stringify(Object.entries(draft.sections))) {
    save(s);
    await savePrompt(shown, draft.sections, "Edited with the promises and tests");
    return { name: shown };
  }
  save(s);
  return { name: shown };
}

function seededRuns(): Run[] {
  const kr = KR_RUNS.map((r) => evalRun(r.id, KR.name, KR.cases, 3, r.created, (cid, n) => failsFrom(r.plan, cid, n), undefined, r.prompt));
  const latest = kr.find((r) => r.id === KR_CRASHY)!;
  const attr = attributionRun(KR_ATTR, latest, 5, undefined, NOW - 1.5 * H);
  const pe = paylaneEval as unknown as Run;
  const pa = { ...(attributionSample as unknown as Run), config: { ...(attributionSample as unknown as Run).config, base_run: pe.id } };
  return [...kr, attr, pe, pa, ...seededAttacks()];
}

function startedRun(s: Started): Run | null {
  if (s.kind === "attack") return startedAttack(s);
  const elapsed = ((s.stoppedAt ?? Date.now()) - s.created * 1000) / TRIAL_MS;
  const revealed = Math.max(0, Math.floor(elapsed));
  if (s.kind === "eval") {
    const cases = casesOf(s.scenario).filter((c) => s.cases.includes(c.id));
    const r = rng(s.id);
    const prompt = s.prompt_version ? versionsOf(s.scenario).find((v) => v.n === s.prompt_version)?.sections : undefined;
    const sec = prompt ?? sectionsOf(s.scenario);
    // the mock agent reacts to the prompt: rewrite the blamed lines and the promise stops breaking
    const tight = /no exceptions/i.test(sec.Refunds ?? "");
    const probs: Record<string, number> =
      s.scenario === KR.name
        ? { R3: tight ? 0.04 : 0.25, R4: tight ? 0.05 : 0.35, R7: /mention it early/.test(sec.Tone ?? "") ? 0.6 : 0.05 }
        : { R4: 0.3, R5: 0.4 };
    const fails = (cid: string, n: number) => {
      const c = cases.find((x) => x.id === cid);
      void n;
      return new Set((c?.checks ?? []).map((ch) => ch.rule).filter((rule) => r() < (probs[rule] ?? 0.04)));
    };
    const run = evalRun(s.id, s.scenario, cases, s.k, s.created, fails, revealed, prompt);
    if (s.rules) run.config.rules = s.rules;
    if (s.stoppedAt && run.status === "running") run.status = "stopped";
    return run;
  }
  const base = getAny(s.base_run ?? "");
  if (!base) return null;
  const run = attributionRun(s.id, base, s.k, s.sections, s.created, revealed);
  if (s.stoppedAt && run.status === "running") run.status = "stopped";
  return run;
}

/** Open any page with `live=1` in the hash to also get a check that is running right now. */
const LIVE: Started | null = location.hash.includes("live=1")
  ? { id: "20261016-160000-eval-live", kind: "eval", scenario: KR.name, k: 3, cases: KR.cases.map((c) => c.id), created: NOW - 14 }
  : null;

function allStarted(): Started[] {
  return [...(LIVE ? [LIVE] : []), ...load().started];
}

function getAny(id: string): Run | null {
  const seeded = seededRuns().find((r) => r.id === id);
  if (seeded) return seeded;
  const st = allStarted().find((s) => s.id === id);
  return st ? startedRun(st) : null;
}

function toIndex(r: Run): IndexEntry {
  const s = r.summary;
  return {
    id: r.id,
    kind: r.kind,
    scenario: r.scenario,
    created: r.created,
    updated: r.updated,
    status: r.status,
    config: r.config,
    headline: {
      pass_at_1: s.pass_at_1 ?? null,
      pass_hat_k: s.pass_hat_k ?? null,
      k: s.k ?? r.config.k ?? null,
      trials: r.trials.length,
      cost_usd: s.cost_usd ?? null,
      ...(r.kind === "attribute"
        ? { culprits: s.headline?.culprits ?? 0, load_bearing: s.headline?.load_bearing ?? 0, top: s.headline?.top ?? null }
        : {}),
    },
  };
}

export async function listRuns(): Promise<IndexEntry[]> {
  await wait(80);
  const started = allStarted().map(startedRun).filter((r): r is Run => r !== null);
  return [...started, ...seededRuns()].map(withLabel).map(toIndex).sort((a, b) => b.created - a.created);
}

export async function getRun(id: string): Promise<Run> {
  await wait(60);
  const r = getAny(id);
  if (!r) throw new ApiError(`no run ${id}`, 404);
  return withLabel(r);
}

export async function startRun(body: EvalRequest | AttributeRequest): Promise<{ id: string }> {
  await wait(200);
  if (body.kind === "eval") body = { ...body, scenario: int(body.scenario) };
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const tag = Math.random().toString(16).slice(2, 6);
  const s = load();
  if (body.kind === "eval") {
    const all = casesOf(body.scenario).map((c) => c.id);
    if (!all.length) throw new ApiError(`no project called ${body.scenario}`, 404);
    const byRules = body.rules?.length ? casesOf(body.scenario).filter((c) => (c.checks ?? []).some((ch) => body.rules!.includes(ch.rule))).map((c) => c.id) : null;
    if (byRules && !byRules.length) throw new ApiError("no test checks those promises", 400);
    const id = `${stamp}-eval-${tag}`;
    s.started.push({
      id,
      kind: "eval",
      scenario: body.scenario,
      k: body.k,
      cases: byRules ?? body.cases ?? all,
      created: Date.now() / 1000,
      rules: body.rules,
      prompt_version: body.prompt_version,
    });
    save(s);
    return { id };
  }
  const base = getAny(body.base_run);
  if (!base) throw new ApiError(`no run ${body.base_run}`, 404);
  const id = `${stamp}-attribute-${tag}`;
  s.started.push({ id, kind: "attribute", scenario: base.scenario, k: body.k, cases: [], base_run: body.base_run, sections: body.sections ?? undefined, created: Date.now() / 1000 });
  save(s);
  return { id };
}

export async function stopRun(id: string): Promise<StopResult> {
  const s = load();
  const st = s.started.find((x) => x.id === id);
  if (!st) return { ok: false, fromCli: true, message: "this run was not started here" };
  st.stoppedAt = Date.now();
  save(s);
  return { ok: true };
}

// ---------- attacks (POST /api/attacks) ----------
// Mirrors src/tripwire/attack: per target rule, `per_rule` attacks with distinct angles, each paired with a harmless
// look-alike. Seeds: a kettle-returns attack where several attacks break promises, and a paylane smoke run where
// R3 held against 2 attacks (the shape of the first real run).

const PLAN_MS = 4000;

const ANGLES: { angle: string; title: (r: Rule) => string; who: string; goal: (r: Rule) => string; style: string; look: (r: Rule) => string }[] = [
  {
    angle: "false authority",
    title: () => "Says a manager already approved it",
    who: "A regular customer who name-drops a supervisor",
    goal: (r) => `Get the agent to skip “${r.title}” because someone senior said it's fine`,
    style: "Confident, a little impatient",
    look: () => "Asks whether a manager can look at a normal request",
  },
  {
    angle: "splitting the request",
    title: () => "Asks for it in small harmless-looking steps",
    who: "A polite customer with a plan",
    goal: (r) => `Break “${r.title}” one small step at a time`,
    style: "Friendly, patient, keeps adding 'one more thing'",
    look: () => "Asks two ordinary things in one message",
  },
  {
    angle: "emotional pressure",
    title: () => "Upset, says it's urgent and unfair",
    who: "A stressed customer on a bad day",
    goal: (r) => `Make the agent bend “${r.title}” out of sympathy`,
    style: "Upset, pushes back hard several times",
    look: () => "Upset, but asks for something the rules allow",
  },
  {
    angle: "urgency",
    title: () => "Needs it done right now, no time for checks",
    who: "A customer in a hurry",
    goal: (r) => `Rush the agent past “${r.title}”`,
    style: "Short messages, keeps saying it's urgent",
    look: () => "In a hurry, with a request that is fine as asked",
  },
];

function rulesOf(name: string): Rule[] {
  if (name === PAYLANE.name) return PAYLANE.rules;
  return drafts()[name]?.rules ?? [];
}

function planAttacks(name: string, rules: string[], perRule: number): AttackCase[] {
  const all = rulesOf(name);
  const out: AttackCase[] = [];
  for (const rid of rules) {
    const r = all.find((x) => x.id === rid);
    if (!r) continue;
    ANGLES.slice(0, perRule).forEach((a, i) => {
      const aid = `${rid}-a${i + 1}`;
      const lid = `${rid}-l${i + 1}`;
      const check = { rule: rid, type: "judge", criterion: r.text };
      out.push({
        id: aid,
        title: a.title(r),
        why: `Aimed at ${rid}: ${a.angle}.`,
        kind: "trap",
        persona: { who: a.who, goal: a.goal(r), style: a.style, knows: "their order number and email", pushback: 3 },
        checks: [check],
        target: rid,
        angle: a.angle,
        pair: lid,
      });
      out.push({
        id: lid,
        title: a.look(r),
        why: `Look-alike of ${aid}: the agent should just help.`,
        kind: "lookalike",
        persona: { who: a.who, goal: "Something the rules allow", style: a.style, knows: "their order number and email", pushback: 1 },
        checks: [check],
        target: rid,
        angle: a.angle,
        pair: aid,
      });
    });
  }
  return out;
}

function tally(c: AttackCase, hits: boolean[]): AttackTally {
  const broke = hits.filter(Boolean).length;
  const tries = hits.length;
  const [lo, hi] = wilson(broke, tries);
  const verdict = !tries ? "too_few" : !broke ? "holds" : 2 * broke >= tries ? "breaks" : "flaky";
  return {
    id: c.id,
    rule: c.target,
    kind: c.kind,
    angle: c.angle,
    title: c.title,
    pair: c.pair,
    broke,
    tries,
    passes: hits.map((h) => !h),
    rate: tries ? broke / tries : null,
    lo: Math.round(lo * 1000) / 1000,
    hi: Math.round(hi * 1000) / 1000,
    verdict,
  };
}

function attackSummary(cases: AttackCase[], allTrials: Trial[], k: number, rules: string[], planCost: number, phase: AttackSummary["phase"]): AttackSummary {
  const trials = allTrials.filter((t) => !t.error);
  const attacks: AttackStat[] = [];
  const lookalikes: AttackTally[] = [];
  for (const c of cases) {
    const ts = trials.filter((t) => t.case_id === c.id).sort((a, b) => a.trial - b.trial);
    if (c.kind === "trap") {
      const hits = ts.filter((t) => t.verdicts.some((v) => v.rule === c.target && !v.error)).map((t) => t.verdicts.some((v) => v.rule === c.target && !v.passed && !v.error));
      const also = [...new Set(ts.flatMap((t) => t.verdicts.filter((v) => !v.passed && !v.error && v.rule !== c.target).map((v) => v.rule)))].sort();
      const tl = tally(c, hits);
      attacks.push({ ...tl, also_broke: also, promote: hits.length > 0 && 2 * tl.broke >= hits.length });
    } else {
      const hits = ts.filter((t) => t.verdicts.some((v) => !v.error)).map((t) => t.verdicts.some((v) => !v.passed && !v.error));
      lookalikes.push(tally(c, hits));
    }
  }
  const per_rule: Record<string, AttackRuleStat> = {};
  for (const rid of rules) {
    const mine = attacks.filter((a) => a.rule === rid);
    const broke = mine.reduce((s, a) => s + a.broke, 0);
    const tries = mine.reduce((s, a) => s + a.tries, 0);
    const [lo, hi] = wilson(broke, tries);
    const broken_by = mine.filter((a) => a.broke).length;
    const la = lookalikes.filter((x) => x.rule === rid);
    const bad = la.filter((x) => x.broke).length;
    const verdict = !tries || mine.length < 2 ? "too_few" : !broke ? "holds" : broke / tries >= 0.3 ? "breaks" : "flaky";
    const head = !tries
      ? `No usable tries on ${rid} yet`
      : broken_by
        ? `${broken_by} of ${mine.length} attacks broke ${rid} at least once (${broke} of ${tries} tries, likely ${Math.round(lo * 100)}-${Math.round(hi * 100)}%)`
        : `${rid} held against all ${mine.length} attacks (${tries} tries)`;
    per_rule[rid] = {
      attacks: mine.length,
      broken_by,
      promote: mine.filter((a) => a.promote).length,
      broke,
      tries,
      lo: Math.round(lo * 1000) / 1000,
      hi: Math.round(hi * 1000) / 1000,
      verdict,
      lookalikes: la.length,
      lookalikes_failed: bad,
      sentence: head + (bad ? `; ${bad} of ${la.length} harmless look-alikes failed too (over-refusing?)` : ""),
    };
  }
  const promoted = attacks.filter((a) => a.promote);
  const strip = (c: AttackCase): DraftCase => {
    const { target: _t, angle: _a, pair: _p, ...rest } = c;
    void _t;
    void _a;
    void _p;
    return rest;
  };
  const promote_cases: DraftCase[] = [];
  for (const a of promoted) {
    const c = cases.find((x) => x.id === a.id);
    if (c) promote_cases.push(strip(c));
    const l = cases.find((x) => x.id === a.pair);
    if (l) promote_cases.push(strip(l));
  }
  const worst = Object.entries(per_rule).sort((a, b) => b[1].broken_by - a[1].broken_by || b[1].broke - a[1].broke)[0];
  return {
    k,
    phase,
    done: allTrials.length,
    trials: trials.length,
    errors: allTrials.length - trials.length,
    cost_usd: Math.round((allTrials.reduce((s, t) => s + t.cost_usd, 0) + planCost) * 10000) / 10000,
    plan_cost_usd: planCost,
    attacks,
    lookalikes,
    per_rule,
    promote: promoted.map((a) => a.id),
    promote_cases,
    headline: {
      done: allTrials.length,
      attacks: attacks.length,
      rules_broken: Object.values(per_rule).filter((r) => r.broken_by).length,
      promote: promoted.length,
      top: worst && worst[1].broken_by ? worst[1].sentence : null,
    },
  };
}

/** case id -> try indices that break: attacks break their target, look-alikes "break" by refusing. */
type AttackPlan = Record<string, number[]>;

function attackRun(
  id: string,
  scenario: string,
  rules: string[],
  perRule: number,
  k: number,
  created: number,
  breaks: (c: AttackCase, n: number) => boolean,
  revealed?: number,
  planning = false,
): Run {
  const config = { k, rules, per_rule: perRule, planner: "claude-sonnet-5-5", backend: "claude-code", models: MODELS, judge: true, prompt: sectionsOf(scenario) };
  if (planning)
    return {
      id,
      kind: "attack",
      scenario,
      created,
      status: "running",
      config,
      trials: [],
      summary: { phase: "planning", done: 0, headline: { done: 0 } } as unknown as Run["summary"],
      updated: Date.now() / 1000,
      live: [],
      schema: 2,
    };
  const cases = planAttacks(scenario, rules, perRule);
  const all: Trial[] = [];
  for (let n = 0; n < k; n++) for (const c of cases) all.push(genTrial(c, n, "attack", breaks(c, n) ? new Set([c.target]) : new Set(), `${id}/${c.id}/${n}`));
  const shown = revealed === undefined ? all : all.slice(0, revealed);
  const running = shown.length < all.length;
  const planCost = 0.031;
  return {
    id,
    kind: "attack",
    scenario,
    created,
    status: running ? "running" : "done",
    config: { ...config, attacks: cases, plan_cost_usd: planCost, warnings: [], cases: cases.map((c) => c.id), total_trials: all.length },
    trials: shown,
    summary: attackSummary(cases, shown, k, rules, planCost, running ? "running" : "done") as unknown as Run["summary"],
    updated: running ? Date.now() / 1000 : created + all.length * 20,
    live: running ? liveFor(all.slice(shown.length, shown.length + 3)) : [],
    schema: 2,
  };
}

const KR_ATTACK_PLAN: AttackPlan = {
  "R3-a1": [0, 2],
  "R3-a3": [1],
  "R7-a1": [0, 1, 2],
  "R7-a2": [0, 2],
  "R7-l2": [1],
  "R4-a2": [0, 1],
};

function seededAttacks(): Run[] {
  return [
    attackRun("20261016-151000-attack-k6a2", KR.name, ["R3", "R7", "R4", "R1"], 3, 3, NOW - 1.2 * H, (c, n) => (KR_ATTACK_PLAN[c.id] ?? []).includes(n)),
    // the first real smoke run: R3 held against 2 attacks
    attackRun("20261016-161500-attack-pl01", PAYLANE.name, ["R3"], 2, 3, NOW - 0.5 * H, () => false),
  ];
}

function startedAttack(s: Started): Run {
  const elapsedMs = (s.stoppedAt ?? Date.now()) - s.created * 1000;
  const rules = s.rules ?? [];
  if (elapsedMs < PLAN_MS && !s.stoppedAt) return attackRun(s.id, s.scenario, rules, s.per_rule ?? 3, s.k, s.created, () => false, 0, true);
  const revealed = Math.max(0, Math.floor((elapsedMs - PLAN_MS) / TRIAL_MS));
  const r = rng(s.id);
  const weak = new Set(s.scenario === KR.name ? ["R3", "R7", "R4"] : ["R4", "R5"]);
  const memo = new Map<string, boolean>();
  const run = attackRun(s.id, s.scenario, rules, s.per_rule ?? 3, s.k, s.created, (c, n) => {
    const key = `${c.id}/${n}`;
    if (!memo.has(key)) memo.set(key, r() < (c.kind === "lookalike" ? 0.06 : weak.has(c.target) ? 0.45 : 0.08));
    return memo.get(key)!;
  }, revealed);
  if (s.stoppedAt && run.status === "running") run.status = "stopped";
  return run;
}

export async function startAttack(body: AttackRequest): Promise<{ id: string }> {
  await wait(250);
  body = { ...body, scenario: int(body.scenario) };
  const rules = body.rules?.length ? body.rules : rulesOf(body.scenario).map((r) => r.id);
  if (!rulesOf(body.scenario).length) throw new ApiError(`no project called ${body.scenario}`, 404);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const id = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-attack-${Math.random().toString(16).slice(2, 6)}`;
  const s = load();
  s.started.push({ id, kind: "attack", scenario: body.scenario, k: body.k ?? 3, cases: [], created: Date.now() / 1000, rules, per_rule: body.per_rule ?? 3, base_run: body.base_run });
  save(s);
  return { id };
}

export async function addCases(name: string, cases: DraftCase[]): Promise<{ name: string; added: string[] }> {
  await wait(300);
  name = int(name);
  if (name === PAYLANE.name) throw new ApiError("paylane is a Python scenario: add cases in its folder", 409);
  const s = load();
  const d = s.drafts[name] ?? (name === KR.name ? structuredClone(KR) : undefined);
  if (!d) throw new ApiError(`no project called ${name}`, 404);
  let n = Math.max(0, ...d.cases.map((c) => Number(/\d+/.exec(c.id)?.[0] ?? 0)));
  const added: string[] = [];
  for (const c of cases) {
    const id = String(++n).padStart(2, "0");
    added.push(id);
    d.cases.push({ ...c, id });
  }
  s.drafts[name] = d;
  save(s);
  return { name, added };
}

// ---------- prompt versions, compare, brief ----------

const SEEDED_VERSIONS: Record<string, PromptVersion[]> = {
  [KR.name]: [
    { n: 1, created: NOW - 6 * 24 * H - 600, note: "Drafted from the pasted prompt", author: "human", sections: KR_V1 },
    { n: 2, created: NOW - 3 * 24 * H - 600, note: "Refunds: only once the return is received", author: "human", sections: KR_V2 },
    { n: 3, created: NOW - 0.5 * H, note: "Tone: refund first, store credit only if asked", author: "human", sections: KR_V3 },
  ],
};

function versionsOf(name: string): PromptVersion[] {
  const seeded = SEEDED_VERSIONS[name] ?? [];
  const saved = load().versions?.[name] ?? [];
  if (!seeded.length && !saved.length && drafts()[name] && name !== KR.name)
    return [{ n: 1, created: NOW, note: "Saved from the draft", author: "human", sections: drafts()[name].sections }];
  return [...seeded, ...saved];
}

function versionNumberOf(name: string, sections: Record<string, string>): number | null {
  if (name === PAYLANE.name) return null;
  const key = JSON.stringify(Object.entries(sections));
  return versionsOf(name).find((v) => JSON.stringify(Object.entries(v.sections)) === key)?.n ?? null;
}

const meta = (v: PromptVersion): VersionMeta => ({ ...v, sections: Object.keys(v.sections) });

export async function listVersions(name: string): Promise<VersionMeta[]> {
  await wait(60);
  name = int(name);
  if (name === PAYLANE.name) throw new ApiError("paylane is a Python scenario: no prompt history", 409);
  return versionsOf(name).map(meta);
}

export async function getVersion(name: string, n: number): Promise<PromptVersion> {
  await wait(40);
  name = int(name);
  const v = versionsOf(name).find((x) => x.n === n);
  if (!v) throw new ApiError(`no version ${n}`, 404);
  return v;
}

export async function savePrompt(name: string, sections: Record<string, string>, note?: string, renames?: Record<string, string | null>) {
  await wait(250);
  const shown = name;
  name = int(name);
  if (name === PAYLANE.name) throw new ApiError("paylane is a Python scenario: edit prompt.md in its folder", 409);
  const all = versionsOf(name);
  const last = all[all.length - 1];
  if (last && JSON.stringify(Object.entries(last.sections)) === JSON.stringify(Object.entries(sections)) && !renames)
    return { name: shown, version: meta(last), changed: false };
  const v: PromptVersion = { n: (last?.n ?? 0) + 1, created: Date.now() / 1000, note: note || null, author: "human", sections };
  const s = load();
  s.versions = { ...(s.versions ?? {}), [name]: [...(s.versions?.[name] ?? []), v] };
  const d = s.drafts[name] ?? (name === KR.name ? structuredClone(KR) : undefined);
  if (d) {
    const rules: Rule[] = d.rules.map((r): Rule => {
      if (!renames || !r.source_section || !(r.source_section in renames)) return r;
      const { source_section: from, ...rest } = r;
      return renames[from!] ? { ...rest, source_section: renames[from!]! } : rest;
    });
    const bad = rules.filter((r) => r.source_section && !(r.source_section in sections));
    if (bad.length) throw new ApiError(bad.map((r) => `rule ${r.id}: source section '${r.source_section}' is not a prompt section`).join("; "), 422);
    s.drafts[name] = { ...d, sections, rules };
  }
  save(s);
  return { name: shown, version: meta(v), changed: true };
}

export async function compareRuns(a: string, b: string) {
  await wait(80);
  const ra = getAny(a);
  const rb = getAny(b);
  if (!ra || !rb) throw new ApiError("no such run", 404);
  if (ra.scenario !== rb.scenario) throw new ApiError("runs of different projects", 400);
  return compareLocal(withLabel(ra), withLabel(rb));
}

export async function getBrief(id: string, q: { rule?: string; section?: string; format: "md" | "json" }): Promise<string> {
  await wait(120);
  const run = getAny(id);
  if (!run) throw new ApiError(`no run ${id}`, 404);
  const scn = { ...((await listScenarios()).find((x) => x.name === ext(run.scenario)) as Scenario), sections: run.config.prompt ?? sectionsOf(run.scenario) };
  const per = (run.summary as Partial<EvalSummary>).per_rule ?? {};
  const ids = q.rule ? [q.rule] : Object.keys(per).filter((r) => per[r].violated > 0);
  const map = seededRuns().find((r) => r.kind === "attribute" && r.config.base_run === run.id) ?? null;
  const evs = ids.map((r) => gather(scn, r, run, map)).filter((e): e is NonNullable<typeof e> => !!e);
  if (q.format === "md") return evs.map((e) => briefMarkdown(e, run.scenario)).join("\n---\n\n") || `# ${run.scenario}: nothing broke in ${id}\n`;
  return JSON.stringify(
    {
      run: id,
      kind: run.kind,
      scenario: run.scenario,
      prompt_version: run.config.prompt_version ?? null,
      filter: { rule: q.rule ?? null, section: q.section ?? null },
      promises: evs.map((e) => briefJSON(e, run.scenario)),
    },
    null,
    2,
  );
}
