// A promise's title, text and part, editable wherever the promise is shown (its page, the evidence panel, the
// draft review). Adding a promise from a part of the prompt, and the drafter's notes, live here too.
import { useState } from "react";
import { addRule, deleteRule, setRule } from "../lib/draft";
import { useEditing, type Editing } from "../lib/edit";
import type { Rule } from "../lib/types";
import { ask } from "./Dialog";
import { partLabel } from "./Doc";
import { Editable, EditSelect, useSaving } from "./Editable";

/** The pieces of one promise as editable fields. Read-only when the project can't be edited. */
export function usePromiseFields(rule: Rule) {
  const { draft, editable, update } = useEditing();
  const sections = Object.keys(draft?.sections ?? {});
  const title = (
    <Editable
      value={rule.title}
      label="promise name"
      placeholder="Short name, e.g. Verify before refunds"
      readOnly={!editable}
      onSave={(v) => update(setRule(rule.id, { title: v }))}
    />
  );
  const text = (
    <Editable
      value={rule.text}
      label="promise"
      multiline
      placeholder="What the agent must always (or never) do."
      readOnly={!editable}
      onSave={(v) => update(setRule(rule.id, { text: v }))}
    />
  );
  const part = (
    <EditSelect
      value={rule.source_section && sections.includes(rule.source_section) ? rule.source_section : ""}
      label={`${rule.id}: which part of the prompt it comes from`}
      readOnly={!editable}
      className="part-pick"
      options={[{ value: "", label: "whole prompt" }, ...sections.map((s) => ({ value: s, label: partLabel(s) }))]}
      onSave={(v) => update(setRule(rule.id, { source_section: v || undefined }))}
    />
  );
  return { title, text, part, editable };
}

/** Delete a promise after asking; tests that only check it go too. */
export function useDeletePromise() {
  return deletePromiseWith(useEditing());
}

export function deletePromiseWith({ draft, update }: Editing) {
  return async (id: string) => {
    const tests = (draft?.cases ?? []).filter((c) => c.checks.some((ch) => ch.rule === id));
    const only = tests.filter((c) => c.checks.every((ch) => ch.rule === id));
    const ok = await ask({
      title: `Delete ${id}?`,
      body: tests.length ? (
        <p>
          Its checks come out of {tests.length} test{tests.length === 1 ? "" : "s"}
          {only.length ? `; ${only.length} that check nothing else go too` : ""}. Old reports keep their results.
        </p>
      ) : (
        <p>Nothing tests it yet. Old reports keep their results.</p>
      ),
      confirm: "Delete promise",
      danger: true,
    });
    if (!ok) return false;
    await update(deleteRule(id));
    return true;
  };
}

/** "+ Add a promise" that opens a blank note in place. */
export function AddPromise({ section, label = "+ Add a promise from this part" }: { section: string | null; label?: string }) {
  const { editable, update } = useEditing();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const s = useSaving();
  if (!editable) return null;
  if (!open)
    return (
      <button type="button" className="add-note" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  const done = () => {
    setOpen(false);
    setTitle("");
    setText("");
  };
  const add = async () => {
    if (!title.trim() || !text.trim()) return;
    if (await s.run(() => update(addRule({ id: "", title: title.trim(), text: text.trim(), ...(section ? { source_section: section } : {}) })))) done();
  };
  return (
    <form
      className="note note-new"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done();
        }
      }}
    >
      <span className="note-top">
        <span className="rule-ref">new</span>
        <span className="quiet">{section ? partLabel(section) : "whole prompt"}</span>
      </span>
      <input className="note-title-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short name, e.g. Verify before refunds" aria-label="New promise name" />
      <textarea
        className="note-text-input"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            add();
          }
        }}
        placeholder="What the agent must always (or never) do."
        aria-label="New promise"
      />
      <span className="note-foot">
        <button type="submit" className="btn btn-ink btn-sm" disabled={!title.trim() || !text.trim() || s.busy}>
          Add
        </button>
        <button type="button" className="link-btn quiet-btn" onClick={done}>
          Cancel
        </button>
        {s.mark}
      </span>
    </form>
  );
}

/** The drafter's open questions, each one dismissable once dealt with. */
export function DrafterNotes() {
  const { draft, editable, update } = useEditing();
  const s = useSaving();
  const notes = draft?.notes ?? [];
  if (!notes.length) return null;
  return (
    <div className="drafter-notes">
      <ol className="comment-list">
        {notes.map((n) => (
          <li key={n}>
            <span>{n}</span>
            {editable && (
              <button
                type="button"
                className="link-btn quiet-btn note-resolve"
                onClick={() => s.run(() => update((d) => ({ ...d, notes: d.notes.filter((x) => x !== n) })))}
                aria-label={`Mark as dealt with: ${n}`}
              >
                Resolve
              </button>
            )}
          </li>
        ))}
      </ol>
      {s.mark}
    </div>
  );
}

export const notesLabel = (n: number) => `${n === 1 ? "1 thing" : `${n} things`} we weren't sure about`;
