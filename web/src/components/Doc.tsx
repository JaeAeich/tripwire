// The prompt as a document, with margin notes. Every page that shows a prompt (review, report, map, project) uses it:
// the text sits on the left like a page, notes about each part sit in the right margin next to it, and hovering a
// note highlights the sentence it is about.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { sentences } from "../lib/anchor";
import { Chip } from "./Chip";

export type Tone = "breaks" | "flaky" | "holds" | "too_few" | "up" | "cause" | "maybe-up" | "maybe-cause" | "plain";

export interface Mark {
  /** what the mark belongs to, usually a rule id; hovering that thing lights the mark */
  key: string;
  sentence: number;
  tone: Tone;
}

const SEVERITY: Tone[] = ["breaks", "cause", "flaky", "maybe-cause", "too_few", "up", "maybe-up", "holds", "plain"];
const worst = (ts: Tone[]) => ts.sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b))[0];

interface Hot {
  key: string | null;
  section: string | null;
}
const HotCtx = createContext<{ hot: Hot; setHot: (h: Hot) => void; pinned: string | null }>({
  hot: { key: null, section: null },
  setHot: () => {},
  pinned: null,
});

/** `pinned` keeps one thing lit, e.g. the promise whose panel is open. */
export function HotProvider({ children, pinned = null }: { children: ReactNode; pinned?: string | null }) {
  const [hot, setHot] = useState<Hot>({ key: null, section: null });
  return <HotCtx.Provider value={{ hot, setHot, pinned }}>{children}</HotCtx.Provider>;
}

export const useHot = () => useContext(HotCtx);

/** Props to spread on anything that should light up its sentence in the document when hovered or focused. */
export function useHotProps(key: string, section: string | null) {
  const { hot, setHot } = useHot();
  const on = () => setHot({ key, section });
  const off = () => setHot({ key: null, section: null });
  const isHot = hot.key === key || (hot.key === null && hot.section !== null && hot.section === section);
  return { isHot, props: { onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off } };
}

export function partLabel(name: string) {
  return name === "preamble" ? "Opening lines" : name;
}

export function PromptDoc({
  sections,
  marks,
  edge,
  margin,
  dim,
  lead,
  after,
  renderText,
  tagFor,
  onPick,
  headAction,
  renderHead,
}: {
  /** replaces the part's name in its heading, e.g. with an editable name */
  renderHead?: (section: string) => ReactNode;
  sections: Record<string, string>;
  marks?: (section: string) => Mark[];
  /** colour of the part's left edge, e.g. its worst verdict */
  edge?: (section: string) => Tone | undefined;
  margin: (section: string) => ReactNode;
  dim?: (section: string) => boolean;
  /** a margin block above the first part, for notes about the whole prompt */
  lead?: { label: ReactNode; body?: ReactNode; notes: ReactNode };
  after?: ReactNode;
  /** replaces the rendered paragraph, e.g. with an editor or a diff */
  renderText?: (section: string) => ReactNode;
  /** a short label shown right after a mark, e.g. "R3", so you know which promise a line is about */
  tagFor?: (key: string, tone: Tone) => string | null;
  /** clicking a mark (or its label) picks that promise */
  onPick?: (key: string, section: string) => void;
  /** e.g. an "Edit" button next to the part's heading */
  headAction?: (section: string) => ReactNode;
}) {
  const { hot, setHot, pinned } = useHot();
  return (
    <div className="doc">
      {lead && (
        <section className="doc-row doc-lead">
          <div className="doc-text">
            <p className="doc-lead-label">{lead.label}</p>
            {lead.body}
          </div>
          <aside className="doc-margin">{lead.notes}</aside>
        </section>
      )}
      {Object.entries(sections).map(([name, text]) => {
        const ms = marks?.(name) ?? [];
        const bySentence = new Map<number, Mark[]>();
        for (const m of ms) bySentence.set(m.sentence, [...(bySentence.get(m.sentence) ?? []), m]);
        const e = edge?.(name);
        const sectionHot = hot.section === name;
        return (
          <section
            key={name}
            id={`part-${slug(name)}`}
            className={`doc-row${e ? ` edge-${e}` : ""}${dim?.(name) ? " is-dim" : ""}${sectionHot ? " is-hot" : ""}`}
            onMouseEnter={() => hot.key === null && setHot({ key: null, section: name })}
            onMouseLeave={() => hot.key === null && setHot({ key: null, section: null })}
          >
            <div className="doc-text">
              <h3 className="doc-h">
                {name !== "preamble" && (
                  <span className="doc-hash" aria-hidden="true">
                    ##
                  </span>
                )}
                {renderHead ? renderHead(name) : partLabel(name)}
                {headAction && <span className="doc-head-action">{headAction(name)}</span>}
              </h3>
              {renderText && renderText(name) != null ? (
                renderText(name)
              ) : (
              <p className="doc-p">
                {sentences(text).map((s, i) => {
                  const here = bySentence.get(i);
                  if (!here) return <span key={i}>{s}</span>;
                  const tone = worst(here.map((m) => m.tone));
                  const lit = here.some((m) => m.key === hot.key || m.key === pinned);
                  const tags = tagFor ? here.map((m) => ({ m, t: tagFor(m.key, m.tone) })).filter((x) => x.t) : [];
                  const pick = onPick ? () => onPick(here[0].key, name) : undefined;
                  return (
                    <span key={i}>
                      <mark
                        className={`mk mk-${tone}${lit ? " is-lit" : ""}${pick ? " is-pickable" : ""}`}
                        onClick={pick}
                        onMouseEnter={() => setHot({ key: here[0].key, section: name })}
                        onMouseLeave={() => setHot({ key: null, section: null })}
                      >
                        {s}
                      </mark>
                      {tags.map(({ m, t }) => (
                        <button
                          key={m.key}
                          type="button"
                          className={`mk-tag mk-tag-${m.tone}${m.key === hot.key || m.key === pinned ? " is-lit" : ""}`}
                          onClick={() => onPick?.(m.key, name)}
                          onMouseEnter={() => setHot({ key: m.key, section: name })}
                          onMouseLeave={() => setHot({ key: null, section: null })}
                        >
                          {t}
                        </button>
                      ))}
                    </span>
                  );
                })}
              </p>
              )}
            </div>
            <aside className="doc-margin" aria-label={`Notes on ${partLabel(name)}`}>
              {margin(name)}
            </aside>
          </section>
        );
      })}
      {after}
    </div>
  );
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** A note in the margin. Hover lights the sentence it is about. */
export function Note({
  hotKey,
  section,
  tone,
  children,
  onClick,
  selected,
  label,
}: {
  hotKey: string;
  section: string | null;
  tone?: Tone;
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  label?: string;
}) {
  const { isHot, props } = useHotProps(hotKey, section);
  const cls = `note${tone ? ` note-${tone}` : ""}${isHot ? " is-hot" : ""}${selected ? " is-selected" : ""}${onClick ? " is-button" : ""}`;
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} aria-label={label} {...props}>
        {children}
      </button>
    );
  return (
    <div className={cls} {...props}>
      {children}
    </div>
  );
}

export function Soon({ children }: { children: ReactNode }) {
  return (
    <span className="soon-action" title="Coming soon">
      {children} <Chip>soon</Chip>
    </span>
  );
}

/** The side panel. Esc or the backdrop closes it. */
/** The side panel. Esc or the backdrop closes it. `docked` keeps the page usable beside it (no backdrop). */
export function Drawer({ open, onClose, children, label, docked }: { open: boolean; onClose: () => void; children: ReactNode; label: string; docked?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`drawer-wrap${docked ? " is-docked" : ""}`}>
      {!docked && <button type="button" className="drawer-scrim" aria-label="Close panel" onClick={onClose} />}
      <aside className="drawer" role="dialog" aria-label={label}>
        <button type="button" className="drawer-x" onClick={onClose} aria-label="Close">
          ×
        </button>
        {children}
      </aside>
    </div>
  );
}
