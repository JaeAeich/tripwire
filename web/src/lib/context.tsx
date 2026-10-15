import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { detectMode, listRuns, listScenarios, type Mode } from "./api";
import { useAsync } from "./hooks";
import type { IndexEntry, Rule, Scenario } from "./types";

interface AppData {
  mode: Mode | null;
  scenarios: Scenario[];
  scenariosError?: Error;
  /** every run, newest first; refreshed while any is running */
  runs: IndexEntry[] | undefined;
  runsError?: Error;
  reloadRuns: () => void;
  reloadScenarios: () => void;
  /** show a saved edit right away, until the list reloads; null hides the project */
  putScenario: (name: string, s: Scenario | null) => void;
}

const Ctx = createContext<AppData>({
  mode: null,
  scenarios: [],
  runs: undefined,
  reloadRuns: () => {},
  reloadScenarios: () => {},
  putScenario: () => {},
});

export function AppDataProvider({ children }: { children: ReactNode }) {
  const mode = useAsync(detectMode, []);
  const scenarios = useAsync(listScenarios, []);
  const runs = useAsync(listRuns, []);
  // optimistic edits, dropped whenever a fresh list arrives
  const [over, setOver] = useState<Record<string, Scenario | null>>({});
  useEffect(() => setOver({}), [scenarios.data]);
  const putScenario = useCallback((name: string, s: Scenario | null) => setOver((o) => ({ ...o, [name]: s })), []);
  const shown = useMemo(() => {
    const base = (scenarios.data ?? []).map((s) => (s.name in over ? over[s.name] : s)).filter((s): s is Scenario => !!s);
    const added = Object.values(over).filter((s): s is Scenario => !!s && !base.some((b) => b.name === s.name));
    return [...base, ...added];
  }, [scenarios.data, over]);
  const anyRunning = useMemo(() => runs.data?.some((r) => r.status === "running"), [runs.data]);
  useEffect(() => {
    if (mode.data !== "local") return;
    const t = window.setTimeout(runs.reload, anyRunning ? 2500 : 20000);
    return () => window.clearTimeout(t);
  }, [anyRunning, mode.data, runs.data, runs.reload]);
  const sorted = useMemo(() => runs.data && [...runs.data].sort((a, b) => b.created - a.created), [runs.data]);
  return (
    <Ctx.Provider
      value={{
        mode: mode.data ?? null,
        scenarios: shown,
        scenariosError: scenarios.error,
        runs: sorted,
        runsError: runs.error,
        reloadRuns: runs.reload,
        reloadScenarios: scenarios.reload,
        putScenario,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAppData() {
  return useContext(Ctx);
}

export function useScenario(name: string | undefined): Scenario | undefined {
  const { scenarios } = useAppData();
  return scenarios.find((s) => s.name === name);
}

export function useRules(scenario: string | undefined): Record<string, Rule> {
  const s = useScenario(scenario);
  const out: Record<string, Rule> = {};
  for (const r of s?.rules ?? []) out[r.id] = r;
  return out;
}
