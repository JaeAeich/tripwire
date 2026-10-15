// The app shell: a slim left rail (workspace, runs, projects, new check) and the page area. On phones the rail
// becomes a top bar with a menu.
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { MOCK } from "../lib/api";
import { useAppData } from "../lib/context";
import { scenarioHref } from "../lib/routes";
import { displayName } from "../lib/draft";
import { DialogHost } from "./Dialog";
import type { IndexEntry } from "../lib/types";

export function Wordmark() {
  // the word with a spell-check squiggle under it: a document that flags what breaks
  return (
    <span className="wordmark-text">
      trip<span className="wordmark-squiggle">wire</span>
    </span>
  );
}

/** A dot for a project's latest check: green all passed, amber mostly, red otherwise, pulsing while running. */
export function StatusDot({ entry }: { entry?: IndexEntry }) {
  if (!entry) return <span className="sdot sdot-none" title="Not checked yet" />;
  if (entry.status === "running") return <span className="sdot sdot-run" title="Checking now" />;
  const p = entry.headline?.pass_at_1;
  if (p === null || p === undefined) return <span className="sdot sdot-none" title="No result" />;
  const cls = p >= 0.999 ? "ok" : p >= 0.85 ? "warn" : "bad";
  return <span className={`sdot sdot-${cls}`} title={`Latest check: ${Math.round(p * 100)}% of conversations passed`} />;
}

function Rail({ onNavigate, collapsed, onToggle }: { onNavigate?: () => void; collapsed?: boolean; onToggle?: () => void }) {
  const { mode, scenarios, runs } = useAppData();
  const live = (runs ?? []).filter((r) => r.status === "running");
  const latest = (name: string) => (runs ?? []).find((r) => r.kind === "eval" && r.scenario === name);
  return (
    <nav className="rail" aria-label="Main" onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}>
      <div className="rail-top">
        <Link to="/" className="rail-brand" aria-label="tripwire workspace">
          {collapsed ? <span className="wordmark-text wordmark-squiggle">t</span> : <Wordmark />}
        </Link>
        {onToggle && (
          <button type="button" className="rail-toggle" onClick={onToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={`${collapsed ? "Expand" : "Collapse"} sidebar  [`}>
            {collapsed ? "»" : "«"}
          </button>
        )}
      </div>
      <Link to="/check" className="btn btn-ink rail-new" title="New project">
        <span aria-hidden="true">+</span>
        <span className="rail-label">New project</span>
      </Link>
      <div className="rail-group">
        <NavLink to="/" end className="rail-link">
          <span className="rail-ico" aria-hidden="true">
            ⌂
          </span>
          <span className="rail-label">Workspace</span>
        </NavLink>
        <NavLink to="/runs" end className="rail-link">
          <span className="rail-ico" aria-hidden="true">
            ≡
          </span>
          <span className="rail-label">All runs</span>
          {live.length > 0 && <span className="rail-badge">{collapsed ? live.length : `${live.length} live`}</span>}
        </NavLink>
      </div>
      <div className="rail-group">
        <p className="rail-h rail-label">Projects</p>
        {scenarios.map((s) => (
          <NavLink key={s.name} to={scenarioHref(s.name)} title={displayName(s)} className={({ isActive }) => `rail-link rail-project${isActive ? " active" : ""}`}>
            <StatusDot entry={latest(s.name)} />
            <span className="rail-name rail-label">{displayName(s)}</span>
            {collapsed && <span className="rail-initial">{displayName(s).slice(0, 2)}</span>}
          </NavLink>
        ))}
        {!scenarios.length && <p className="rail-empty rail-label">No projects yet</p>}
      </div>
      <div className="rail-foot rail-label">
        {mode === "static" && <span title="No local API found. Showing a saved snapshot.">Read-only demo</span>}
        {mode === "local" && <span title={MOCK ? "Mock data (VITE_MOCK=1)" : "Connected to tripwire serve"}>{MOCK ? "Mock data" : "Local · tripwire serve"}</span>}
      </div>
    </nav>
  );
}

const RAIL_KEY = "tw-rail";

function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(RAIL_KEY, c ? "open" : "collapsed");
      } catch {
        /* private mode */
      }
      return !c;
    });
  // "[" toggles the sidebar, unless you're typing
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return [collapsed, toggle];
}

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, toggle] = useCollapsed();
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <div className={`shell${collapsed ? " is-collapsed" : ""}`}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <button type="button" className="topbar-menu" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span />
          <span />
          <span />
        </button>
        <Link to="/" className="wordmark">
          <Wordmark />
        </Link>
        <Link to="/check" className="btn btn-ink btn-sm topbar-new">
          + New project
        </Link>
      </header>
      <div className={`rail-wrap${open ? " is-open" : ""}`}>
        <Rail onNavigate={() => setOpen(false)} collapsed={collapsed && !open} onToggle={open ? undefined : toggle} />
      </div>
      {open && <button type="button" className="rail-scrim" aria-label="Close menu" onClick={() => setOpen(false)} />}
      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>
      <DialogHost />
    </div>
  );
}
