// The one edit pattern. Text reads normally; hover or focus shows a faint tint and a ✎ in its corner. Click (or
// Enter) turns it into a field in the same font and size, so nothing moves. Enter or leaving the field saves, Esc
// puts it back. "Saving…", "Saved" or what went wrong appear in place, never as a toast.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

type Status = "idle" | "saving" | "saved";

const SAVED_MS = 1600;

/** return this from onSave when the change is kept but not saved yet (e.g. a check still missing a field) */
export const PENDING = "pending";

function useStatus() {
  const [status, setStatus] = useState<Status>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const saved = () => {
    setStatus("saved");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus("idle"), SAVED_MS);
  };
  return { status, setStatus, saved };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d{3} /, "");

function Mark({ status, editing }: { status: Status; editing: boolean }) {
  const text = status === "saving" ? "Saving…" : status === "saved" ? "Saved" : editing ? "" : "✎";
  return (
    <span className={`ed-mark${status !== "idle" ? " is-on" : ""}${status === "saved" ? " is-saved" : ""}`} aria-live="polite">
      {text}
    </span>
  );
}

export function Editable({
  value,
  onSave,
  label,
  multiline = false,
  enter = "save",
  placeholder,
  readOnly = false,
  className = "",
  display,
  validate,
  allowEmpty = false,
  autoEdit = false,
}: {
  value: string;
  /** throw to keep the field open with the error shown */
  onSave: (v: string) => Promise<unknown> | unknown;
  /** what this is, for screen readers and error messages: "promise title" */
  label: string;
  multiline?: boolean;
  /** multiline only: "newline" lets Enter add lines (then ⌘/Ctrl+Enter saves) */
  enter?: "save" | "newline";
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  /** how the value reads when not editing (default: the text itself) */
  display?: ReactNode;
  validate?: (v: string) => string | null;
  allowEmpty?: boolean;
  /** open in edit mode on mount, e.g. right after "Add" */
  autoEdit?: boolean;
}) {
  const [editing, setEditing] = useState(autoEdit && !readOnly);
  const [draft, setDraft] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const { status, setStatus, saved } = useStatus();
  const busy = useRef(false);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const Tag = multiline ? "div" : "span";

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (!editing || !field.current) return;
    const f = field.current;
    f.focus();
    const end = f.value.length;
    f.setSelectionRange(end, end);
  }, [editing]);

  if (readOnly)
    return <Tag className={`ed-ro${multiline ? " ed-block" : ""} ${className}`}>{value ? display ?? value : <span className="ed-ph">{placeholder ?? "–"}</span>}</Tag>;

  const start = () => {
    if (window.getSelection()?.toString()) return; // selecting text to copy, not editing
    setDraft(value);
    setErr(null);
    setEditing(true);
  };
  const cancel = () => {
    setDraft(value);
    setErr(null);
    setEditing(false);
  };
  const commit = async () => {
    if (busy.current) return;
    const v = multiline ? draft.replace(/\s+$/, "") : draft.trim();
    if (v === value) return cancel();
    if (!v && !allowEmpty) return setErr(`The ${label} can't be empty. Esc puts it back.`);
    const problem = validate?.(v);
    if (problem) return setErr(problem);
    busy.current = true;
    setStatus("saving");
    try {
      const r = await onSave(v);
      setErr(null);
      setEditing(false);
      if (r === PENDING) setStatus("idle");
      else saved();
    } catch (e) {
      setErr(message(e));
      setStatus("idle");
    } finally {
      busy.current = false;
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't also close the drawer or menu around it
      cancel();
    } else if (e.key === "Enter" && (!multiline || (enter === "save" ? !e.shiftKey : e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      commit();
    }
  };

  const cls = `ed${multiline ? " ed-block" : ""}${editing ? " is-editing" : ""}${err ? " has-err" : ""}${!value && !editing ? " is-empty" : ""} ${className}`;
  if (!editing)
    return (
      <Tag
        className={cls}
        role="button"
        tabIndex={0}
        aria-label={`${label}: ${value || "empty"}. Press Enter to edit`}
        title={`Edit ${label}`}
        onClick={start}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            start();
          }
        }}
      >
        {value ? display ?? value : <span className="ed-ph">{placeholder ?? `Add ${label}`}</span>}
        <Mark status={status} editing={false} />
      </Tag>
    );
  const common = {
    ref: field,
    className: "ed-field",
    value: draft,
    placeholder,
    "aria-label": label,
    "aria-invalid": err ? true : undefined,
    readOnly: status === "saving",
    onChange: (e: { target: { value: string } }) => {
      setDraft(e.target.value);
      if (err) setErr(null);
    },
    onKeyDown: onKey,
    onBlur: () => {
      commit();
    },
  };
  return (
    <Tag className={cls}>
      {multiline ? <textarea {...common} rows={1} /> : <input {...common} type="text" size={Math.max(4, draft.length + 1)} />}
      <Mark status={status} editing />
      {err && (
        <span className="ed-err" role="alert">
          {err}
        </span>
      )}
    </Tag>
  );
}

/** A choice from a short list, edited the same way: it reads as text, and saves the moment it changes. */
export function EditSelect<T extends string>({
  value,
  options,
  onSave,
  label,
  readOnly = false,
  className = "",
}: {
  value: T;
  options: { value: T; label: string }[];
  onSave: (v: T) => Promise<unknown> | unknown;
  label: string;
  readOnly?: boolean;
  className?: string;
}) {
  const { status, setStatus, saved } = useStatus();
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState<T>(value);
  useEffect(() => setShown(value), [value]);
  const current = options.find((o) => o.value === shown)?.label ?? shown;
  if (readOnly) return <span className={`ed-ro ${className}`}>{current}</span>;
  return (
    <span className={`ed ed-choice${err ? " has-err" : ""} ${className}`}>
      <select
        className="ed-select"
        value={shown}
        aria-label={label}
        disabled={status === "saving"}
        onChange={async (e) => {
          const v = e.target.value as T;
          setShown(v);
          setErr(null);
          setStatus("saving");
          try {
            const r = await onSave(v);
            if (r === PENDING) setStatus("idle");
            else saved();
          } catch (x) {
            setShown(value);
            setErr(message(x));
            setStatus("idle");
          }
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="ed-caret" aria-hidden="true">
        ▾
      </span>
      <Mark status={status} editing />
      {err && (
        <span className="ed-err" role="alert">
          {err}
        </span>
      )}
    </span>
  );
}

/** A yes/no that saves on click, shown as the chip it describes. */
export function EditToggle({
  value,
  on,
  off,
  onSave,
  label,
  readOnly = false,
}: {
  value: boolean;
  on: ReactNode;
  off: ReactNode;
  onSave: (v: boolean) => Promise<unknown> | unknown;
  label: string;
  readOnly?: boolean;
}) {
  const { status, setStatus, saved } = useStatus();
  const [err, setErr] = useState<string | null>(null);
  if (readOnly) return <span className="ed-ro">{value ? on : off}</span>;
  return (
    <span className={`ed ed-choice${err ? " has-err" : ""}`}>
      <button
        type="button"
        className="ed-toggle"
        aria-pressed={value}
        aria-label={label}
        title={`${label}: click to change`}
        disabled={status === "saving"}
        onClick={async () => {
          setErr(null);
          setStatus("saving");
          try {
            await onSave(!value);
            saved();
          } catch (x) {
            setErr(message(x));
            setStatus("idle");
          }
        }}
      >
        {value ? on : off}
      </button>
      <Mark status={status} editing />
      {err && (
        <span className="ed-err" role="alert">
          {err}
        </span>
      )}
    </span>
  );
}

/** Run an action that saves (delete, add, move) and say how it went in place. */
export function useSaving() {
  const { status, setStatus, saved } = useStatus();
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown> | unknown) => {
    setErr(null);
    setStatus("saving");
    try {
      await fn();
      saved();
      return true;
    } catch (e) {
      setErr(message(e));
      setStatus("idle");
      return false;
    }
  };
  const mark = (
    <span className={`save-note${err ? " is-err" : ""}`} aria-live="polite" role={err ? "alert" : undefined}>
      {err ?? (status === "saving" ? "Saving…" : status === "saved" ? "Saved" : "")}
    </span>
  );
  return { run, busy: status === "saving", mark, err };
}
