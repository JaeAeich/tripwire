// Small pieces shared by the draft review, the project page and the report.
import { useState, type ReactNode } from "react";
import { pct } from "../lib/format";
import type { Case, CaseKind, DraftCase, Rule, RuleVerdict, ToolSpec } from "../lib/types";
import { checkGrader, checkSentence, KIND_WORDS, VERDICT_WORDS } from "../lib/words";
import { Chip, verdictTone } from "./Chip";

export function VerdictChip({ verdict }: { verdict: RuleVerdict; small?: boolean }) {
  const w = VERDICT_WORDS[verdict];
  return (
    <Chip tone={verdictTone(verdict)} dot title={w.help}>
      {w.label}
    </Chip>
  );
}

export function KindBadge({ kind }: { kind?: CaseKind }) {
  if (!kind) return null;
  const w = KIND_WORDS[kind];
  return (
    <Chip title={w.help}>{w.label}</Chip>
  );
}

/** How often a promise broke: a 0-100% track, the likely range as a band, the observed rate as a tick. */
export function IntervalBar({
  rate,
  lo,
  hi,
  verdict,
  compact,
}: {
  rate: number;
  lo: number;
  hi: number;
  verdict: RuleVerdict;
  compact?: boolean;
}) {
  const label = `Broke in ${pct(rate)} of runs; likely between ${pct(lo)} and ${pct(hi)}`;
  return (
    <span className={`ibar is-${verdict}${compact ? " is-compact" : ""}`} title={label} role="img" aria-label={label}>
      <span className="ibar-track">
        <span className="ibar-band" style={{ left: `${lo * 100}%`, width: `${Math.max(1, (hi - lo) * 100)}%` }} />
        <span className="ibar-dot" style={{ left: `${rate * 100}%` }} />
      </span>
      {!compact && (
        <span className="ibar-nums">
          broke <b>{pct(rate)}</b> of the time{" "}
          <span className="quiet">{lo <= 0.005 ? `(likely under ${pct(hi)})` : `(likely ${pct(lo)}–${pct(hi)})`}</span>
        </span>
      )}
    </span>
  );
}

/** "Prompt → Review → Run" progress for the first-run flow. */
export function FlowSteps({ at }: { at: 1 | 2 | 3 }) {
  const steps = ["Paste your prompt", "Review the promises", "Run the check"];
  return (
    <ol className="flow-steps" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s} className={i + 1 < at ? "is-done" : i + 1 === at ? "is-now" : ""} aria-current={i + 1 === at ? "step" : undefined}>
          <span className="flow-n">{i + 1 < at ? "✓" : i + 1}</span> {s}
        </li>
      ))}
    </ol>
  );
}

function Persona({ c }: { c: Case | DraftCase }) {
  const p = c.persona;
  if (!p) return null;
  const rows: [string, ReactNode][] = [
    ["Who", p.who],
    ["Wants", p.goal],
    ["How they talk", p.style],
    ["Knows", p.knows],
  ];
  return (
    <dl className="persona">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      {typeof p.pushback === "number" && (
        <div>
          <dt>Pushes back</dt>
          <dd>
            <span className="pushback" aria-label={`${p.pushback} out of 3`}>
              {[1, 2, 3].map((n) => (
                <span key={n} className={n <= (p.pushback ?? 0) ? "is-on" : ""} />
              ))}
            </span>{" "}
            {["not at all", "a little", "firmly", "hard, several times"][Math.max(0, Math.min(3, p.pushback))]}
          </dd>
        </div>
      )}
    </dl>
  );
}

/** One test conversation: title line, then (expanded) the customer and what we check. */
export function CaseItem({
  c,
  rules,
  primary,
  onDelete,
  startOpen = false,
  extra,
}: {
  c: Case | DraftCase;
  rules: Record<string, Rule>;
  primary?: string;
  onDelete?: () => void;
  startOpen?: boolean;
  /** shown at the right of the title line, e.g. this test's results */
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  const others = [...new Set((c.checks ?? []).map((x) => x.rule))].filter((r) => r !== primary);
  const script = "script" in c ? c.script : null;
  return (
    <li className={`tcase${open ? " is-open" : ""}`}>
      <div className="tcase-head">
        <button type="button" className="tcase-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="tcase-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <KindBadge kind={c.kind} />
          <span className="tcase-title">{c.title}</span>
        </button>
        {extra}
        {onDelete && (
          <button type="button" className="link-btn tcase-del" onClick={onDelete} aria-label={`Delete test ${c.id}`}>
            Delete
          </button>
        )}
      </div>
      {open && (
        <div className="tcase-body">
          {c.why && <p className="tcase-why">{c.why}</p>}
          <p className="label">{script ? "The customer says" : "The simulated customer"}</p>
          <Persona c={c} />
          {script && (
            <ol className="script">
              {script.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ol>
          )}
          <p className="label">It passes if</p>
          <ul className="check-sentences">
            {(c.checks ?? []).map((ch, i) => (
              <li key={i}>
                <span className="rule-ref" title={rules[ch.rule]?.title}>
                  {ch.rule}
                </span>
                <span>{checkSentence(ch)}</span>
                <Chip title={checkGrader(ch) === "code" ? "checked by code" : "checked by a reviewer model"}>{checkGrader(ch) === "code" ? "exact" : "judgment"}</Chip>
              </li>
            ))}
          </ul>
          {others.length > 0 && <p className="quiet small">Also checks {others.join(", ")}.</p>}
        </div>
      )}
    </li>
  );
}

/** Test conversations grouped by the promise they mainly test. */
export function CasesByPromise({
  cases,
  rules,
  onDelete,
  only,
}: {
  cases: (Case | DraftCase)[];
  rules: Rule[];
  onDelete?: (id: string) => void;
  only?: string;
}) {
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  const primary = (c: Case | DraftCase) => c.checks?.[0]?.rule ?? "";
  const groups = rules.filter((r) => !only || r.id === only).map((r) => ({ rule: r, cases: cases.filter((c) => primary(c) === r.id) }));
  const orphans = only ? [] : cases.filter((c) => !byId[primary(c)]);
  return (
    <div className="by-promise">
      {groups.map(({ rule, cases: cs }) => {
        const kinds = new Set(cs.map((c) => c.kind));
        return (
          <section key={rule.id} className="bp-group">
            {!only && (
              <h3 className="bp-head">
                <span className="rule-ref">{rule.id}</span> {rule.title || <span className="quiet">untitled promise</span>}
                <span className="quiet bp-count">{cs.length ? `${cs.length} test${cs.length === 1 ? "" : "s"}` : "no tests"}</span>
              </h3>
            )}
            {cs.length === 0 ? (
              <p className="quiet bp-empty">Nothing tests this promise yet, so it won't be checked.</p>
            ) : (
              <ul className="tcases">
                {cs.map((c) => (
                  <CaseItem key={c.id} c={c} rules={byId} primary={rule.id} onDelete={onDelete ? () => onDelete(c.id) : undefined} />
                ))}
              </ul>
            )}
            {cs.length > 0 && cs.some((c) => c.kind) && !kinds.has("lookalike") && (
              <p className="quiet bp-empty">No look-alike test: an agent that refuses everything would pass this promise.</p>
            )}
          </section>
        );
      })}
      {orphans.length > 0 && (
        <section className="bp-group">
          <h3 className="bp-head">Other tests</h3>
          <ul className="tcases">
            {orphans.map((c) => (
              <CaseItem key={c.id} c={c} rules={byId} onDelete={onDelete ? () => onDelete(c.id) : undefined} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function ToolList({ tools }: { tools: ToolSpec[] }) {
  if (!tools.length) return <p className="quiet">No tools.</p>;
  return (
    <ul className="tools">
      {tools.map((t) => {
        const props = Object.keys(((t.input_schema as { properties?: Record<string, unknown> }).properties ?? {}) as object);
        return (
          <li key={t.name} className="tool">
            <p className="tool-sig">
              <code>
                {t.name}({props.join(", ")})
              </code>
              {t.mutates ? <Chip tone="flaky">changes data</Chip> : <Chip>read only</Chip>}
            </p>
            <p className="tool-desc">{t.description}</p>
          </li>
        );
      })}
    </ul>
  );
}
