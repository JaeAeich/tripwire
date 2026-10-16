// Editing the prompt's structure: a part's name (in its heading), moving it, deleting it, adding a new one.
// On a saved project each change is a new prompt version; promises follow renamed parts.
import { useState } from "react";
import { movePart, partNameProblem, renamePart } from "../lib/draft";
import { useEditing } from "../lib/edit";
import { ask } from "./Dialog";
import { partLabel } from "./Doc";
import { Editable, useSaving } from "./Editable";
import { MoreMenu } from "./ProjectFrame";

export function PartName({ name }: { name: string }) {
  const { draft, editable, savePrompt } = useEditing();
  const sections = draft?.sections ?? {};
  const shown = partLabel(name);
  return (
    <Editable
      value={shown}
      label="part name"
      readOnly={!editable}
      validate={(v) => partNameProblem(v, sections, name)}
      onSave={(v) => {
        if (v === shown) return;
        return savePrompt((cur) => renamePart(cur, name, v), { renames: { [name]: v }, note: `Renamed part “${shown}” to “${v}”` });
      }}
    />
  );
}

export function PartMenu({ name }: { name: string }) {
  const { draft, editable, savePrompt } = useEditing();
  const s = useSaving();
  if (!editable || !draft) return null;
  const keys = Object.keys(draft.sections);
  const i = keys.indexOf(name);
  const label = partLabel(name);
  const move = (by: -1 | 1) => s.run(() => savePrompt((cur) => movePart(cur, name, by), { note: `Moved “${label}” ${by < 0 ? "up" : "down"}` }));
  const del = async () => {
    const promises = draft.rules.filter((r) => r.source_section === name).map((r) => r.id);
    const ok = await ask({
      title: `Delete the part “${label}”?`,
      body: (
        <p>
          Its text leaves the prompt{promises.length ? `; ${promises.join(", ")} will be about the whole prompt` : ""}. The old version stays in the history.
        </p>
      ),
      confirm: "Delete part",
      danger: true,
    });
    if (!ok) return;
    const rest = (cur: Record<string, string>) => Object.fromEntries(Object.entries(cur).filter(([k]) => k !== name));
    s.run(() => savePrompt(rest, { renames: { [name]: null }, note: `Deleted part “${label}”` }));
  };
  return (
    <span className="part-menu">
      <MoreMenu
        small
        label={`More for ${label}`}
        items={[
          ...(i > 0 ? [{ label: "Move up", onClick: () => move(-1) }] : []),
          ...(i < keys.length - 1 ? [{ label: "Move down", onClick: () => move(1) }] : []),
          ...(keys.length > 1 ? [{ label: "Delete part…", onClick: del }] : []),
        ]}
      />
      {s.mark}
    </span>
  );
}

/** "+ Add a part" at the end of the prompt, opening a heading and text in place. */
export function AddPart() {
  const { draft, editable, savePrompt } = useEditing();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const s = useSaving();
  if (!editable || !draft) return null;
  const problem = name.trim() ? partNameProblem(name, draft.sections) : null;
  const done = () => {
    setOpen(false);
    setName("");
    setText("");
  };
  if (!open)
    return (
      <div className="doc-row doc-add">
        <div className="doc-text">
          <button type="button" className="add-note add-part" onClick={() => setOpen(true)}>
            + Add a part
          </button>
        </div>
        <aside className="doc-margin" />
      </div>
    );
  const add = async () => {
    if (!name.trim() || !text.trim() || problem) return;
    if (await s.run(() => savePrompt((cur) => ({ ...cur, [name.trim()]: text.trim() }), { note: `Added part “${name.trim()}”` }))) done();
  };
  return (
    <section className="doc-row doc-add">
      <form
        className="doc-text"
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
        <h3 className="doc-h">
          <span className="doc-hash" aria-hidden="true">
            ##
          </span>
          <input className="ed-field ed-new-h" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name of the part, e.g. Escalation" aria-label="New part name" />
        </h3>
        <textarea className="ed-field doc-p ed-new-p" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What the agent should do here, in your own words." aria-label="New part text" />
        <p className="row-actions">
          <button type="submit" className="btn btn-ink btn-sm" disabled={!name.trim() || !text.trim() || !!problem || s.busy}>
            Add part
          </button>
          <button type="button" className="btn btn-line btn-sm" onClick={done}>
            Cancel
          </button>
          {problem ? <span className="form-error small">{problem}</span> : s.mark}
        </p>
      </form>
      <aside className="doc-margin" />
    </section>
  );
}
