// One fetch module, two modes.
//   local:  `tripwire serve` on :8787 (Vite proxies /api in dev; same origin when served by tripwire)
//   static: read-only snapshot under ./data (GitHub Pages demo)
//   mock:   VITE_MOCK=1 pnpm dev -> everything is served from src/dev-fixtures/mock.ts (never bundled otherwise)
import type {
  AttackRequest,
  AttributeRequest,
  CompareResult,
  Draft,
  DraftCase,
  DraftRequest,
  EvalRequest,
  IndexEntry,
  PromptVersion,
  Run,
  Scenario,
  ScenarioDetail,
  VersionMeta,
} from "./types";

/** True under `VITE_MOCK=1`. Vite inlines the value, so the mock module is dropped from normal builds. */
export const MOCK = import.meta.env.VITE_MOCK === "1";
const mock = () => import("../dev-fixtures/mock");

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function errorOf(r: Response): Promise<ApiError> {
  let msg = `${r.status} ${r.statusText}`;
  try {
    const b = await r.json();
    if (b && b.detail) msg = detailText(b.detail);
  } catch {
    /* not json */
  }
  return new ApiError(msg, r.status);
}

/** FastAPI error detail as one plain line: a string, {problems: [...]}, or validation errors. */
function detailText(d: unknown): string {
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && Array.isArray((d as { problems?: unknown }).problems))
    return ((d as { problems: string[] }).problems).join("; ");
  if (Array.isArray(d)) return d.map((x) => (x && typeof x === "object" && "msg" in x ? String(x.msg) : JSON.stringify(x))).join("; ");
  return JSON.stringify(d);
}

async function send<T>(method: string, url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  if ((await detectMode()) !== "local") throw new Error("read-only demo");
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw await errorOf(r);
  return r.json();
}

export type Mode = "local" | "static";

const DEV_FIXTURE_PREFIX = "dev-fixture-";

let modePromise: Promise<Mode> | null = null;

export function detectMode(): Promise<Mode> {
  if (!modePromise) {
    modePromise = (async () => {
      if (MOCK) return "local";
      try {
        const r = await fetch("api/health", { headers: { accept: "application/json" } });
        if (!r.ok) return "static";
        const body = await r.json();
        return body && body.ok ? "local" : "static";
      } catch {
        return "static";
      }
    })();
  }
  return modePromise;
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const b = await r.json();
      if (b && b.detail) msg = String(b.detail);
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export async function listScenarios(): Promise<Scenario[]> {
  if (MOCK) return (await mock()).listScenarios();
  return (await detectMode()) === "local" ? getJSON("api/scenarios") : getJSON("data/scenarios.json");
}

export async function listRuns(): Promise<IndexEntry[]> {
  if (MOCK) return (await mock()).listRuns();
  return (await detectMode()) === "local" ? getJSON("api/runs") : getJSON("data/index.json");
}

export async function getRun(id: string): Promise<Run> {
  if (import.meta.env.DEV && id.startsWith(DEV_FIXTURE_PREFIX)) return loadDevFixture(id);
  if (MOCK) return (await mock()).getRun(id);
  return (await detectMode()) === "local"
    ? getJSON(`api/runs/${encodeURIComponent(id)}`)
    : getJSON(`data/runs/${encodeURIComponent(id)}.json`);
}

export async function startRun(body: EvalRequest | AttributeRequest): Promise<{ id: string }> {
  if (MOCK) return (await mock()).startRun(body);
  return send("POST", "api/runs", body);
}

/** Plan attacks on the chosen promises and run them. Async: the run starts in phase "planning". */
export async function startAttack(body: AttackRequest): Promise<{ id: string }> {
  if (MOCK) return (await mock()).startAttack(body);
  return send("POST", "api/attacks", body);
}

/** Append cases (e.g. promoted attacks) to a simulated project. 409 for Python projects, 422 if invalid. */
export async function addCases(name: string, cases: DraftCase[]): Promise<{ name: string; added: string[] }> {
  if (MOCK) return (await mock()).addCases(name, cases);
  return send("POST", `api/scenarios/${encodeURIComponent(name)}/cases`, { cases });
}

// ---- prompt versions, compare, brief ----

/** Saved prompt versions, oldest first. Throws for Python projects (409) and in the static demo. */
export async function listVersions(name: string): Promise<VersionMeta[]> {
  if (MOCK) return (await mock()).listVersions(name);
  if ((await detectMode()) !== "local") throw new Error("no versions in the static demo");
  return getJSON(`api/scenarios/${encodeURIComponent(name)}/versions`);
}

export async function getVersion(name: string, n: number): Promise<PromptVersion> {
  if (MOCK) return (await mock()).getVersion(name, n);
  return getJSON(`api/scenarios/${encodeURIComponent(name)}/versions/${n}`);
}

/** Save the prompt as a new version (no new version if nothing changed). */
export async function savePrompt(
  name: string,
  sections: Record<string, string>,
  note?: string,
  /** parts renamed (old -> new) or removed (old -> null): their promises follow */
  renames?: Record<string, string | null>,
): Promise<{ name: string; version: VersionMeta; changed: boolean }> {
  if (MOCK) return (await mock()).savePrompt(name, sections, note, renames);
  return send("PUT", `api/scenarios/${encodeURIComponent(name)}/prompt`, { sections, note, renames });
}

/** Change a project's name (its folder). Runs follow it. ApiError 409 if the name is taken. */
export async function renameScenario(name: string, to: string): Promise<{ name: string; runs: number }> {
  if (MOCK) return (await mock()).renameScenario(name, to);
  return send("POST", `api/scenarios/${encodeURIComponent(name)}/rename`, { to });
}

/** Give a run a short label ("" removes it). */
export async function labelRun(id: string, label: string): Promise<{ id: string; label: string }> {
  if (MOCK) return (await mock()).labelRun(id, label);
  return send("PATCH", `api/runs/${encodeURIComponent(id)}`, { label });
}

/** b is the later run. Falls back to a browser computation when the server can't answer (static demo). */
export async function compareRuns(a: string, b: string): Promise<CompareResult> {
  if (MOCK) return (await mock()).compareRuns(a, b);
  if ((await detectMode()) === "local") {
    try {
      return await getJSON<CompareResult>(`api/runs/${encodeURIComponent(a)}/compare/${encodeURIComponent(b)}`);
    } catch {
      /* fall through */
    }
  }
  const { compareLocal } = await import("./compare");
  return compareLocal(await getRun(a), await getRun(b));
}

export const briefUrl = (id: string, q: { rule?: string; section?: string; format: "md" | "json" }) =>
  `api/runs/${encodeURIComponent(id)}/brief?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()}`;

/** The agent brief for a run, as markdown or JSON text. */
export async function getBrief(id: string, q: { rule?: string; section?: string; format: "md" | "json" }): Promise<string> {
  if (MOCK) return (await mock()).getBrief(id, q);
  if ((await detectMode()) !== "local") throw new Error("no brief in the static demo");
  const r = await fetch(briefUrl(id, q), { cache: "no-store" });
  if (!r.ok) throw await errorOf(r);
  return q.format === "json" ? JSON.stringify(await r.json(), null, 2) : r.text();
}

/** Read a prompt and draft promises, tools and test conversations. Slow: 30-120 s. */
export async function draftPrompt(body: DraftRequest, signal?: AbortSignal): Promise<Draft> {
  if (MOCK) return (await mock()).draftPrompt(body, signal);
  return send("POST", "api/draft", body, signal);
}

/** Save a draft as a new project. ApiError 409 if the name is taken and overwrite is false. */
export async function saveScenario(draft: Draft, overwrite = false): Promise<{ name: string }> {
  if (MOCK) return (await mock()).saveScenario(draft, overwrite);
  return send("POST", "api/scenarios", { draft, overwrite });
}

export async function updateScenario(name: string, draft: Draft): Promise<{ name: string }> {
  if (MOCK) return (await mock()).updateScenario(name, draft);
  return send("PUT", `api/scenarios/${encodeURIComponent(name)}`, { draft });
}

/** Full scenario. Falls back to the list entry when the server (or the static demo) has no detail endpoint. */
export async function getScenario(name: string): Promise<ScenarioDetail> {
  if (MOCK) return (await mock()).getScenario(name);
  if ((await detectMode()) === "local") {
    try {
      return await getJSON<ScenarioDetail>(`api/scenarios/${encodeURIComponent(name)}`);
    } catch {
      /* older server: fall through */
    }
  }
  const all = await listScenarios();
  const s = all.find((x) => x.name === name);
  if (!s) throw new ApiError(`no project called ${name}`, 404);
  return { ...s, env_kind: "python", editable: false };
}

export type StopResult = { ok: true } | { ok: false; fromCli: boolean; message: string };

/** Ask the local server to stop a run. 409 = the run is not owned by this server (started from the CLI). */
export async function stopRun(id: string): Promise<StopResult> {
  if (MOCK) return (await mock()).stopRun(id);
  if ((await detectMode()) !== "local") return { ok: false, fromCli: false, message: "read-only demo" };
  try {
    const r = await fetch(`api/runs/${encodeURIComponent(id)}/stop`, { method: "POST" });
    if (r.ok) return { ok: true };
    let msg = `${r.status} ${r.statusText}`;
    try {
      const b = await r.json();
      if (b && b.detail) msg = String(b.detail);
    } catch {
      /* not json */
    }
    return { ok: false, fromCli: r.status === 409, message: msg };
  } catch (e) {
    return { ok: false, fromCli: false, message: (e as Error).message };
  }
}

// Dev-only fixtures: never bundled into a production build (the import sits behind import.meta.env.DEV).
export const DEV_FIXTURES = import.meta.env.DEV ? [`${DEV_FIXTURE_PREFIX}attribution`] : [];

async function loadDevFixture(id: string): Promise<Run> {
  // the `import.meta.env.DEV &&` guard is constant-folded away in production, so the fixture is never bundled
  if (import.meta.env.DEV && id === `${DEV_FIXTURE_PREFIX}attribution`) {
    const mod = await import("../dev-fixtures/attribution.sample.json");
    return mod.default as unknown as Run;
  }
  throw new Error("unknown dev fixture");
}
