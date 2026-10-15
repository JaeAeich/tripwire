// Mirrors src/tripwire/core/trace.py and the summarize() functions. The UI only reads these.

export type Kind = "eval" | "attribute" | "attack";
export type Status = "running" | "done" | "failed" | "stopped";
export type Grader = "state" | "trajectory" | "text" | "judge";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  blocked: boolean;
}

export interface Turn {
  role: "user" | "agent" | "tool";
  text: string | null;
  tool_call: ToolCall | null;
  t: number;
}

export interface Verdict {
  rule: string;
  check: string;
  passed: boolean;
  grader: Grader;
  detail: string;
  step: number | null;
  /** the check itself couldn't run (e.g. the judge hit a rate limit): not a failure */
  error?: boolean;
}

export interface DiffEntry {
  path: string;
  op: "add" | "remove" | "change";
  before?: unknown;
  after?: unknown;
}

export interface Trial {
  case_id: string;
  trial: number;
  variant: string;
  turns: Turn[];
  verdicts: Verdict[];
  passed: boolean;
  state_diff: DiffEntry[];
  cost_usd: number;
  latency_s: number;
  error: string | null;
  /** whole-trial reruns after an infra error; missing on old runs */
  retries?: number;
  protocol_retries?: number;
}

export type LivePhase = "customer" | "agent" | "grading";

/** A conversation in flight, mirrored from the runner every ~1.5 s. */
export interface LiveTrial {
  key: string;
  case_id: string;
  variant: string;
  trial: number;
  attempt: number;
  started: number;
  phase: LivePhase;
  turns: Turn[];
}

export interface RunConfig {
  k?: number;
  /** attack runs: the planned cases, targets, planning cost and planner warnings */
  attacks?: AttackCase[];
  rules?: string[];
  per_rule?: number;
  planner?: string;
  plan_cost_usd?: number;
  warnings?: string[];
  backend?: string;
  models?: { agent: string; user: string; judge: string };
  cases?: string[];
  judge?: boolean;
  sections?: string[];
  prompt?: Record<string, string>;
  total_trials?: number;
  base_run?: string;
  scenario_path?: string;
  trial_timeout_s?: number | null;
  trial_retries?: number;
  /** saved prompt version this run used (simulated projects) */
  prompt_version?: number | null;
  /** free-form note written by whoever ran it */
  note?: string;
  /** short name given in the UI, e.g. "after refund rewrite" (PATCH /api/runs/{id}) */
  label?: string;
  /** case id -> fingerprint when it ran, to tell a test was edited since */
  case_hashes?: Record<string, string>;
}

export interface EvalSummary {
  k: number;
  trials: number;
  done: number;
  pass_at_1: number | null;
  pass_hat_k: number | null;
  cost_usd: number;
  errors: number;
  per_case: Record<string, { passes: boolean[]; pass_rate: number }>;
  per_rule: Record<string, RuleStat>;
  error?: string;
  /** stats layer (2026-10-16); missing on older runs */
  pass_at_1_ci?: [number, number];
  pass_hat_k_ci?: [number, number];
  min_detectable_effect?: number;
  /** checks that couldn't run (not failures); missing on older runs */
  check_errors?: number;
}

export type RuleVerdict = "holds" | "breaks" | "flaky" | "too_few";

export interface RuleStat {
  checked: number;
  violated: number;
  rate: number;
  /** stats layer; missing on older runs */
  cases?: number;
  lo?: number;
  hi?: number;
  verdict?: RuleVerdict;
  sentence?: string;
}

export type Role = "culprit" | "load-bearing" | "unclear";

export interface Cell {
  section: string;
  rule: string;
  base_rate: number;
  ablated_rate: number;
  delta: number;
  ci: [number, number];
  role: Role;
  n: [number, number];
  /** stats layer; missing on older runs */
  lo?: number;
  hi?: number;
  significant?: boolean;
  sentence?: string;
}

export interface AttributionSummary {
  k: number;
  done: number;
  cost_usd: number;
  base_rates: Record<string, { violated: number; checked: number }>;
  matrix: Cell[];
  culprits: Cell[];
  headline?: { culprits: number; load_bearing: number; top: string | null };
  error?: string;
}

export interface Run {
  id: string;
  kind: Kind;
  scenario: string;
  created: number;
  status: Status;
  config: RunConfig;
  trials: Trial[];
  summary: Partial<EvalSummary> & Partial<AttributionSummary> & { error?: string; done?: number; cost_usd?: number };
  schema?: number;
  /** epoch seconds of the last save; 0/missing on old runs */
  updated?: number;
  /** conversations in flight; missing on old runs */
  live?: LiveTrial[];
}

export interface IndexEntry {
  id: string;
  kind: Kind;
  scenario: string;
  created: number;
  updated?: number;
  status: Status;
  config: RunConfig;
  headline: {
    pass_at_1: number | null;
    pass_hat_k: number | null;
    k: number | null;
    trials: number | null;
    cost_usd: number | null;
    // attribution runs only
    culprits?: number;
    load_bearing?: number;
    top?: string | null;
  };
}

export interface Rule {
  id: string;
  title: string;
  text: string;
  /** prompt section this promise was drafted from (drafted scenarios only) */
  source_section?: string;
}

export interface Check {
  rule: string;
  type: string;
  [key: string]: unknown;
}

export interface Persona {
  who?: string;
  goal?: string;
  style?: string;
  knows?: string;
  pushback?: number;
  [key: string]: unknown;
}

export interface Case {
  id: string;
  title: string;
  why: string | null;
  persona: Persona | null;
  script: string[] | null;
  checks: Check[] | null;
  kind?: CaseKind;
  max_turns?: number | null;
  /** fingerprint of persona/script/max_turns/checks; runs record it in config.case_hashes */
  hash?: string;
}

export type CaseKind = "plain" | "trap" | "lookalike";

export interface ModelDefaults {
  agent?: string;
  user?: string;
  judge?: string;
  /** the model that plays the simulated tools */
  tools?: string;
}

export interface Defaults {
  models?: ModelDefaults;
  /** default tries per test */
  k?: number;
  [key: string]: unknown;
}

export interface Scenario {
  name: string;
  /** display name; falls back to the name (the folder) */
  title?: string;
  description: string;
  rules: Rule[];
  sections: Record<string, string>;
  defaults?: Defaults;
  cases: Case[];
  notes?: string[];
  env_kind?: "simulated" | "python";
  editable?: boolean;
}

export type EvalRequest = {
  kind: "eval";
  scenario: string;
  k: number;
  cases: string[] | null;
  judge: boolean;
  /** affected-tests rerun: only cases with a check on these promises */
  rules?: string[];
  /** run a saved prompt version (default: current) */
  prompt_version?: number;
};

// ---- prompt versions, compare, brief (round 5 API) ----

export interface VersionMeta {
  n: number;
  created: number;
  note: string | null;
  author: "human" | "agent" | string;
  sections: string[];
}

export interface PromptVersion extends Omit<VersionMeta, "sections"> {
  sections: Record<string, string>;
}

export interface RuleResult {
  violated: number;
  checked: number;
  cases: number;
  rate: number | null;
  lo: number;
  hi: number;
  verdict: RuleVerdict;
  sentence: string;
}

export type CompareChange = "fixed" | "regressed" | "same" | "new" | "not_rerun";

export interface CompareRow {
  before: RuleResult | null;
  after: RuleResult | null;
  change: CompareChange;
  delta?: number;
  lo?: number;
  hi?: number;
  paired_cases?: number;
  leaning?: "better" | "worse" | null;
  sentence: string;
}

export interface CompareResult {
  a: string;
  b: string;
  scenario: string;
  prompt_versions: [number | null, number | null];
  per_rule: Record<string, CompareRow>;
  fixed: string[];
  regressed: string[];
  same: string[];
  new: string[];
  not_rerun: string[];
  sentence: string;
}
export type AttributeRequest = { kind: "attribute"; base_run: string; k: number; sections: string[] | null };

// ---- drafting (POST /api/draft) and scenario editing ----

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** null for Python scenarios (unknown) */
  mutates: boolean | null;
}

export interface DraftCase {
  id: string;
  title: string;
  why: string;
  kind: CaseKind;
  /** absent on scripted cases */
  persona?: Persona;
  /** fixed customer messages instead of a simulated customer */
  script?: string[];
  max_turns?: number;
  checks: Check[];
}

export interface Draft {
  name: string;
  title?: string;
  description: string;
  defaults?: Defaults;
  sections: Record<string, string>;
  rules: Rule[];
  tools: ToolSpec[];
  world: string;
  fixtures: Record<string, unknown>;
  cases: DraftCase[];
  notes: string[];
}

export interface DraftRequest {
  prompt: string;
  tools?: string;
  name?: string;
}

/** GET /api/scenarios/{name} */
export interface ScenarioDetail {
  name: string;
  title?: string;
  description: string;
  sections: Record<string, string>;
  rules: Rule[];
  cases: (Case | DraftCase)[];
  tools?: ToolSpec[];
  world?: string;
  fixtures?: Record<string, unknown>;
  notes?: string[];
  defaults?: Defaults;
  env_kind?: "simulated" | "python";
  editable?: boolean;
}

// ---- attack (POST /api/attacks; run kind "attack") ----

export interface AttackRequest {
  scenario: string;
  rules?: string[];
  per_rule?: number;
  k?: number;
  base_run?: string;
  judge?: boolean;
}

/** A planned attack or look-alike: a drafted case plus run-only keys. */
export interface AttackCase extends DraftCase {
  target: string;
  angle: string;
  pair: string | null;
}

export interface AttackTally {
  id: string;
  rule: string;
  kind: CaseKind;
  angle: string;
  title: string | null;
  pair: string | null;
  broke: number;
  tries: number;
  passes: boolean[];
  rate: number | null;
  lo: number;
  hi: number;
  verdict: RuleVerdict;
}

export interface AttackStat extends AttackTally {
  also_broke: string[];
  promote: boolean;
}

export interface AttackRuleStat {
  attacks: number;
  broken_by: number;
  promote: number;
  broke: number;
  tries: number;
  lo: number;
  hi: number;
  verdict: RuleVerdict;
  lookalikes: number;
  lookalikes_failed: number;
  sentence: string;
}

export interface AttackSummary {
  k: number;
  phase: "planning" | "running" | "done";
  done: number;
  trials: number;
  errors: number;
  cost_usd: number;
  plan_cost_usd: number;
  attacks: AttackStat[];
  lookalikes: AttackTally[];
  per_rule: Record<string, AttackRuleStat>;
  promote: string[];
  promote_cases: DraftCase[];
  headline: { done: number; attacks?: number; rules_broken?: number; promote?: number; top?: string | null };
}
