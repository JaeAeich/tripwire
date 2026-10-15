import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Status } from "../lib/types";
import { Chip } from "./Chip";

export function StatusTag({ status, stale }: { status: Status; stale?: boolean }) {
  if (status === "running" && stale) return <Chip tone="breaks">not responding</Chip>;
  const words: Record<Status, string> = { running: "running", done: "finished", failed: "crashed", stopped: "stopped" };
  const tone = status === "failed" ? "breaks" : status === "stopped" ? "flaky" : "neutral";
  return (
    <Chip tone={tone} dot={status === "running"}>
      {words[status]}
    </Chip>
  );
}

export function Callout({ children, tone }: { children: ReactNode; tone?: "bad" | "note" }) {
  return <div className={`callout${tone ? ` callout-${tone}` : ""}`}>{children}</div>;
}

export function Loading({ what }: { what: string }) {
  return <p className="quiet loading">Loading {what}…</p>;
}

export function ErrorNote({ error, what }: { error: Error; what: string }) {
  return (
    <Callout tone="bad">
      <p>
        Could not load {what}. <span className="mono">{error.message}</span>
      </p>
    </Callout>
  );
}

export function SectionHead({ title, children, id }: { title: string; children?: ReactNode; id?: string }) {
  return (
    <div className="section-head">
      <h2 id={id}>{title}</h2>
      {children && <div className="section-head-aside">{children}</div>}
    </div>
  );
}

export type Crumb = { to?: string; label: ReactNode };

/** The top of a page, styled like the title block of a document. */
export function DocHead({
  crumbs,
  title,
  sub,
  meta,
  actions,
  children,
  kicker,
}: {
  kicker?: ReactNode;
  crumbs?: Crumb[];
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode[];
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="dochead">
      {kicker}
      {crumbs && crumbs.length > 0 && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="crumb-sep">/</span>}
              {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
            </Fragment>
          ))}
        </nav>
      )}
      <div className="dochead-row">
        <div className="dochead-main">
          <h1 className="doc-title">{title}</h1>
          {sub && <div className="doc-sub">{sub}</div>}
        </div>
        {actions && <div className="dochead-actions">{actions}</div>}
      </div>
      {meta && meta.filter(Boolean).length > 0 && (
        <p className="props">
          {meta.filter(Boolean).map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </p>
      )}
      {children}
    </header>
  );
}
