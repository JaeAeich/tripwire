// Small modal questions: "Delete R3?" and "Rename the project". One host in the layout; call ask() / askText().
import { useEffect, useRef, useState, type ReactNode } from "react";

interface Ask {
  title: string;
  body?: ReactNode;
  confirm: string;
  danger?: boolean;
  /** askText: the field */
  field?: { label: string; value: string; hint?: (v: string) => ReactNode; mono?: boolean };
  /** askText: return an error to keep the dialog open */
  submit?: (v: string) => Promise<string | null>;
  resolve: (v: string | null) => void;
}

let show: ((a: Ask | null) => void) | null = null;

/** Yes/no. Resolves true on confirm. */
export function ask(opts: { title: string; body?: ReactNode; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((res) => {
    if (!show) return res(window.confirm(opts.title));
    show({ ...opts, resolve: (v) => res(v !== null) });
  });
}

/** One line of text, checked by `submit` (which does the work and returns an error or null). */
export function askText(opts: Omit<Ask, "resolve" | "field"> & { field: NonNullable<Ask["field"]> }): Promise<string | null> {
  return new Promise((res) => {
    if (!show) return res(window.prompt(opts.title, opts.field.value));
    show({ ...opts, resolve: res });
  });
}

export function DialogHost() {
  const [a, setA] = useState<Ask | null>(null);
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    show = (x) => {
      setA(x);
      setV(x?.field?.value ?? "");
      setErr(null);
      setBusy(false);
    };
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (!a) return;
    (a.field ? input.current : ok.current)?.focus();
    if (a.field) input.current?.select();
  }, [a]);
  if (!a) return null;
  const close = (val: string | null) => {
    a.resolve(val);
    setA(null);
  };
  const go = async () => {
    if (!a.submit) return close(a.field ? v : "yes");
    setBusy(true);
    const e = await a.submit(v).catch((x: Error) => x.message);
    setBusy(false);
    if (e) setErr(e);
    else close(v);
  };
  return (
    <div
      className="dlg-wrap"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close(null);
        }
      }}
    >
      <button type="button" className="dlg-scrim" aria-label="Cancel" onClick={() => close(null)} />
      <form
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-h"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <h2 id="dlg-h" className="dlg-h">
          {a.title}
        </h2>
        {a.body && <div className="dlg-body">{a.body}</div>}
        {a.field && (
          <label className="dlg-field">
            <span className="label">{a.field.label}</span>
            <input
              ref={input}
              className={a.field.mono ? "mono" : undefined}
              value={v}
              onChange={(e) => {
                setV(e.target.value);
                setErr(null);
              }}
              aria-invalid={err ? true : undefined}
            />
            {a.field.hint && <span className="quiet small">{a.field.hint(v)}</span>}
          </label>
        )}
        {err && (
          <p className="form-error small" role="alert">
            {err}
          </p>
        )}
        <div className="dlg-actions">
          <button type="button" className="btn btn-line" onClick={() => close(null)}>
            Cancel
          </button>
          <button ref={ok} type="submit" className={`btn ${a.danger ? "btn-danger" : "btn-ink"}`} disabled={busy}>
            {busy ? "Working…" : a.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
