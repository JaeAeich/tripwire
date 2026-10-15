// Every project page shares this frame: the name and one line of description, ONE primary action, a "⋯" menu for
// everything else, and the loop as tabs: Overview · Prompt · Tests · Runs · Map · Attack · Fix.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { ApiError, renameScenario, startRun } from "../lib/api";
import { useAppData, useScenario } from "../lib/context";
import { displayName, slugify } from "../lib/draft";
import { ProjectEditing, useEditing, type Editing } from "../lib/edit";
import { runHref, scenarioHref } from "../lib/routes";
import type { IndexEntry } from "../lib/types";
import { estimate } from "../lib/words";
import { Chip } from "./Chip";
import { askText } from "./Dialog";
import { Editable } from "./Editable";

export type Tab = "overview" | "prompt" | "tests" | "runs" | "map" | "attack" | "fix" | "setup";

export function projectRuns(runs: IndexEntry[] | undefined, name: string) {
  return (runs ?? []).filter((r) => r.scenario === name).sort((a, b) => b.created - a.created);
}

function short(ts: number) {
  return new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const KIND: Record<string, string> = { eval: "Check", attribute: "Map", attack: "Attack" };

export function RunSwitcher({ name, runId }: { name: string; runId?: string }) {
  const { runs } = useAppData();
  const nav = useNavigate();
  const mine = projectRuns(runs, name);
  if (!mine.length) return null;
  return (
    <label className="switcher" title="Open another run of this project">
      <span className="switcher-label">Run</span>
      <select value={runId ?? ""} onChange={(e) => e.target.value && nav(runHref(e.target.value))}>
        {!runId && <option value="">Pick a run…</option>}
        {mine.map((r) => (
          <option key={r.id} value={r.id}>
            {KIND[r.kind] ?? r.kind} · {short(r.created)}
            {r.config?.label ? ` · ${r.config.label}` : ""}
            {r.status === "running" ? " · running" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Close a popover on outside click or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", click);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", click);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return { open, setOpen, box };
}

export function RunCheckButton({ name, cases, label = "Run check", k0 = 3 }: { name: string; cases: number; label?: string; k0?: number }) {
  const { mode, reloadRuns } = useAppData();
  const nav = useNavigate();
  const { open, setOpen, box } = usePopover();
  const [k, setK] = useState(k0);
  useEffect(() => setK(k0), [k0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (mode !== "local") return null;
  const n = cases * k;
  const est = estimate(n);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { id } = await startRun({ kind: "eval", scenario: name, k, cases: null, judge: true });
      reloadRuns();
      nav(runHref(id));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="pop-wrap" ref={box}>
      <button type="button" className="btn btn-ink" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!cases}>
        {label}
      </button>
      {open && (
        <div className="pop" role="dialog" aria-label="Run a check">
          <p className="pop-h">Run a check</p>
          <label className="pop-row">
            <span>Tries per test</span>
            <input type="number" min={1} max={10} value={k} onChange={(e) => setK(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
          </label>
          <dl className="pop-facts">
            <div>
              <dt>Conversations</dt>
              <dd>{n}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>~{est.usd}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>~{est.time}</dd>
            </div>
          </dl>
          <button type="button" className="btn btn-ink pop-go" onClick={go} disabled={busy}>
            {busy ? "Starting…" : `Start ${n} conversations`}
          </button>
          {err && <p className="form-error small">{err}</p>}
        </div>
      )}
    </div>
  );
}

/** page-specific ⋯ items; a function gets the editing context (for edit actions) */
export type PageMenu = MenuItem[] | ((e: Editing) => MenuItem[]);

export interface MenuItem {
  label: string;
  to?: string;
  copy?: string;
  onClick?: () => void;
  hint?: string;
}

/** The "⋯" menu: every secondary action of a page in one place. */
export function MoreMenu({ items, small, label = "More actions" }: { items: MenuItem[]; small?: boolean; label?: string }) {
  const { open, setOpen, box } = usePopover();
  const nav = useNavigate();
  const [copied, setCopied] = useState<string | null>(null);
  if (!items.length) return null;
  return (
    <div className="pop-wrap" ref={box}>
      <button type="button" className={small ? "icon-btn menu-dots" : "btn btn-line btn-icon"} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <ul className="menu" role="menu">
          {items.map((it) => (
            <li key={it.label} role="none">
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  if (it.copy) {
                    navigator.clipboard?.writeText(it.copy);
                    setCopied(it.label);
                    window.setTimeout(() => setCopied(null), 1200);
                    return;
                  }
                  setOpen(false);
                  if (it.to) nav(it.to);
                  it.onClick?.();
                }}
              >
                <span>{copied === it.label ? "Copied" : it.label}</span>
                {it.copy ? <code className="menu-hint">{it.copy}</code> : it.hint ? <span className="menu-hint">{it.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ProjectFrame(props: {
  name: string;
  tab: Tab;
  runId?: string;
  primary?: ReactNode | null;
  menu?: PageMenu;
  children: ReactNode;
}) {
  return (
    <ProjectEditing name={props.name}>
      <Frame {...props} />
    </ProjectEditing>
  );
}

/** The project's name and one-line description, edited in place. */
function ProjectHead({ name }: { name: string }) {
  const scn = useScenario(name);
  const { editable, update } = useEditing();
  const title = displayName(scn, name);
  return (
    <div className="phead-id">
      <h1 className="phead-name">
        <Editable value={title} label="project name" readOnly={!editable} onSave={(v) => update((d) => ({ ...d, title: v === name ? "" : v }))} />
      </h1>
      {(scn?.description || editable) && (
        <div className="phead-desc">
          <Editable
            value={scn?.description ?? ""}
            label="description"
            multiline
            allowEmpty
            placeholder="What the agent does, in one line"
            readOnly={!editable}
            onSave={(v) => update((d) => ({ ...d, description: v.replace(/\s*\n\s*/g, " ") }))}
          />
        </div>
      )}
    </div>
  );
}

function Frame({
  name,
  tab,
  runId,
  primary,
  menu = [],
  children,
}: {
  name: string;
  tab: Tab;
  /** run-specific pages show a run picker */
  runId?: string;
  /** the page's one primary action; undefined = Run check, null = none */
  primary?: ReactNode | null;
  /** page-specific secondary actions, shown first in the ⋯ menu */
  menu?: PageMenu;
  children: ReactNode;
}) {
  const scn = useScenario(name);
  const editing = useEditing();
  const { editable } = editing;
  const { runs, reloadRuns, reloadScenarios, putScenario } = useAppData();
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  const mine = projectRuns(runs, name);
  const latestEval = mine.find((r) => r.kind === "eval" && r.status !== "running");
  const prevEval = mine.filter((r) => r.kind === "eval" && r.status !== "running")[1];
  const base = scenarioHref(name);
  // a run started a moment ago may not be in the list yet
  useEffect(() => {
    if (runId && runs && !runs.some((r) => r.id === runId)) reloadRuns();
  }, [runId, runs, reloadRuns]);
  const k = latestEval?.config?.k ?? 3;
  const items: MenuItem[] = [
    ...(typeof menu === "function" ? menu(editing) : menu),
    ...(editable
      ? [
          {
            label: "Rename…",
            hint: name,
            onClick: () =>
              askText({
                title: "Rename the project",
                body: (
                  <p>
                    The name is the folder <code>scenarios/{name}</code>, the URL and what you type in the CLI. Runs move with it.
                  </p>
                ),
                field: {
                  label: "New name",
                  value: name,
                  mono: true,
                  hint: (v) => (slugify(v) && slugify(v) !== v ? `Saved as ${slugify(v)}` : "Lowercase letters, digits and dashes"),
                },
                confirm: "Rename",
                submit: async (v) => {
                  if (!slugify(v)) return "Give it a name";
                  try {
                    const r = await renameScenario(name, v);
                    if (r.name !== name) {
                      if (scn) putScenario(r.name, { ...scn, name: r.name });
                      putScenario(name, null);
                      reloadScenarios();
                      reloadRuns();
                      nav(scenarioHref(r.name) + pathname.slice(base.length) + search, { replace: true });
                    }
                    return null;
                  } catch (e) {
                    if (e instanceof ApiError && e.status === 409) return e.message.includes("still going") ? e.message : `${slugify(v)} is taken`;
                    return (e as Error).message;
                  }
                },
              }),
          },
        ]
      : []),
    { label: "Copy CLI command", copy: `tripwire eval ${name} -k ${k}` },
    { label: "Copy brief command", copy: `tripwire brief ${latestEval?.id ?? "<run>"} --rule ${scn?.rules[0]?.id ?? "R1"}` },
    ...(prevEval && latestEval ? [{ label: "Copy compare command", copy: `tripwire compare ${prevEval.id} ${latestEval.id}` }] : []),
    { label: "Add tripwire to Claude Code (MCP)", copy: "claude mcp add tripwire -- uv run tripwire mcp" },
    { label: "Copy export command", copy: `tripwire export${latestEval ? ` --runs ${latestEval.id}` : ""}` },
  ];
  const needsAttention = latestEval && (latestEval.headline?.pass_at_1 ?? 1) < 1;
  const tabs: { id: Tab; label: string; to: string; count?: number; soon?: boolean; dot?: boolean }[] = [
    { id: "overview", label: "Overview", to: base, dot: needsAttention },
    { id: "prompt", label: "Prompt", to: `${base}/prompt` },
    { id: "tests", label: "Tests", to: `${base}/tests`, count: scn?.cases.length },
    { id: "runs", label: "Runs", to: `${base}/runs`, count: mine.length || undefined },
    { id: "map", label: "Map", to: `${base}/map` },
    { id: "attack", label: "Attack", to: `${base}/attack` },
    { id: "fix", label: "Fix", to: `${base}/fix` },
    { id: "setup", label: "Setup", to: `${base}/setup` },
  ];
  return (
    <div className="project">
      <header className="phead">
        <div className="phead-row">
          <ProjectHead name={name} />
          <div className="phead-actions">
            {runId && <RunSwitcher name={name} runId={runId} />}
            {primary === undefined ? <RunCheckButton name={name} cases={scn?.cases.length ?? 0} k0={scn?.defaults?.k ?? k} /> : primary}
            <MoreMenu items={items} />
          </div>
        </div>
        <nav className="tabs" aria-label="Project">
          {tabs.map((t) => (
            <NavLink key={t.id} to={t.to} end className={`tab${tab === t.id ? " is-active" : ""}`} aria-current={tab === t.id ? "page" : undefined}>
              {t.label}
              {t.dot && <span className="tab-dot" aria-label="needs attention" />}
              {t.count !== undefined && <span className="tab-n">{t.count}</span>}
              {t.soon && <Chip>soon</Chip>}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="project-body">{children}</div>
    </div>
  );
}
