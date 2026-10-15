// One way to edit a project, wherever its pieces are shown. Pages call `update(edit)` with a pure edit from
// lib/draft.ts; the provider decides where it goes:
//   ProjectEditing: a saved project. Each edit is applied to the latest copy from the server and saved (PUT, free);
//                   prompt edits go through PUT .../prompt so they become versions.
//   LocalEditing:   the new-project review. Edits stay in the browser until "Save".
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getScenario, savePrompt as savePromptApi, updateScenario } from "./api";
import { useAppData } from "./context";
import { asDraft, draftToScenario, followRenames } from "./draft";
import type { Draft } from "./types";

export type Edit = (d: Draft) => Draft;
export type PromptEdit = (sections: Record<string, string>) => Record<string, string>;

export interface PromptSave {
  renames?: Record<string, string | null>;
  note?: string;
}

export interface Editing {
  draft: Draft | null;
  /** edits are possible right now */
  editable: boolean;
  /** why not, in a few quiet words (Python projects, the static demo) */
  readOnly?: string;
  /** the new-project review: nothing reaches the server until Save */
  local: boolean;
  update: (edit: Edit) => Promise<void>;
  /** a new prompt version on a saved project; `edit` gets the latest prompt */
  savePrompt: (edit: PromptEdit, opts?: PromptSave) => Promise<{ version: number | null; changed: boolean }>;
}

const Ctx = createContext<Editing>({
  draft: null,
  editable: false,
  local: false,
  update: async () => {
    throw new Error("not editable");
  },
  savePrompt: async () => {
    throw new Error("not editable");
  },
});

export const useEditing = () => useContext(Ctx);

export function ProjectEditing({ name, children }: { name: string; children: ReactNode }) {
  const { mode, scenarios, putScenario, reloadScenarios } = useAppData();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [kind, setKind] = useState<{ editable: boolean; env?: string } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const scnRef = useRef(scenarios);
  scnRef.current = scenarios;

  useEffect(() => {
    let live = true;
    setDraft(null);
    setKind(null);
    getScenario(name).then(
      (s) => {
        if (!live) return;
        setDraft(asDraft(s));
        setKind({ editable: !!s.editable, env: s.env_kind });
      },
      () => live && setKind({ editable: false }),
    );
    return () => {
      live = false;
    };
  }, [name]);

  const show = useCallback(
    (d: Draft) => {
      setDraft(d);
      putScenario(name, draftToScenario(d, scnRef.current.find((s) => s.name === name)));
    },
    [name, putScenario],
  );

  // one save at a time, each on top of the latest server copy
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const p = queue.current.then(job, job);
    queue.current = p.catch(() => undefined);
    return p;
  }, []);

  const update = useCallback(
    (edit: Edit) =>
      enqueue(async () => {
        const cur = asDraft(await getScenario(name));
        const next = edit(cur);
        await updateScenario(name, next);
        show(next);
        reloadScenarios();
      }),
    [enqueue, name, show, reloadScenarios],
  );

  const savePrompt = useCallback(
    (next: PromptEdit, opts: PromptSave = {}) =>
      enqueue(async () => {
        const cur = (await getScenario(name)).sections;
        const saved = await savePromptApi(name, next(cur), opts.note, opts.renames && Object.keys(opts.renames).length ? opts.renames : undefined);
        show(asDraft(await getScenario(name))); // the server moved the promises along with renamed parts
        reloadScenarios();
        return { version: saved.version.n, changed: saved.changed };
      }),
    [enqueue, name, show, reloadScenarios],
  );

  const value = useMemo<Editing>(() => {
    const editable = mode === "local" && !!kind?.editable && !!draft;
    const readOnly =
      mode !== "local" ? "Read-only demo" : kind && !kind.editable && kind.env === "python" ? `Defined in Python code: edit scenarios/${name}` : undefined;
    return { draft, editable, readOnly, local: false, update, savePrompt };
  }, [draft, kind, mode, name, update, savePrompt]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Editing a draft held in memory (the new-project review). */
export function LocalEditing({ draft, onChange, children }: { draft: Draft; onChange: (d: Draft) => void; children: ReactNode }) {
  const ref = useRef(draft);
  ref.current = draft;
  const value = useMemo<Editing>(
    () => ({
      draft,
      editable: true,
      local: true,
      update: async (edit) => {
        const next = edit(ref.current);
        ref.current = next;
        onChange(next);
      },
      savePrompt: async (edit, opts = {}) => {
        const cur = ref.current;
        const next = { ...cur, sections: edit(cur.sections), rules: opts.renames ? followRenames(cur.rules, opts.renames) : cur.rules };
        ref.current = next;
        onChange(next);
        return { version: null, changed: true };
      },
    }),
    [draft, onChange],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
