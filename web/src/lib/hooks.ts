import { useCallback, useEffect, useRef, useState } from "react";
import { detectMode, getRun } from "./api";
import type { Run } from "./types";

export type Async<T> = { data?: T; error?: Error; loading: boolean };

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> & { reload: () => void } {
  const [state, setState] = useState<Async<T>>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (error: Error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

const POLL_MS = 2000;

/** Load a run and poll every 2s while it is running. */
export function useRun(id: string | undefined): Async<Run> {
  const [state, setState] = useState<Async<Run>>({ loading: true });
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setState({ loading: true });
    const load = async () => {
      try {
        const run = await getRun(id);
        if (!live) return;
        setState({ data: run, loading: false });
        // a static snapshot never changes, so only poll a live local server
        if (run.status === "running" && (await detectMode()) === "local" && live)
          timer.current = window.setTimeout(load, POLL_MS);
      } catch (error) {
        if (!live) return;
        setState((s) => ({ data: s.data, error: error as Error, loading: false }));
        // a transient failure mid-run should not stop the live view
        timer.current = window.setTimeout(load, POLL_MS * 2);
      }
    };
    load();
    return () => {
      live = false;
      window.clearTimeout(timer.current);
    };
  }, [id]);
  return state;
}

/** Current time in ms, re-rendering every `ms` while `on`. */
export function useNow(ms = 1000, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms, on]);
  return now;
}

export function usePrefersReducedMotion(): boolean {
  const [r, setR] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setR(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return r;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · tripwire` : "tripwire";
  }, [title]);
}
