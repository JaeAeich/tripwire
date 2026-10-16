import { useEffect, useMemo, useRef } from "react";
import { checkPath, json, readableDetail, verdictStep } from "../lib/format";
import { usePrefersReducedMotion } from "../lib/hooks";
import type { DiffEntry, Rule, ToolCall, Trial, Verdict } from "../lib/types";
import { Chip } from "./Chip";

const ROLE: Record<string, string> = { user: "customer", agent: "agent", tool: "tool" };

/** Steps that failed verdicts point at, with the rules that failed there. */
export function flaggedSteps(verdicts: Verdict[], onlyRule?: string): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const v of verdicts) {
    if (v.passed || v.error || (onlyRule && v.rule !== onlyRule)) continue;
    const s = verdictStep(v);
    if (s === null) continue;
    const list = m.get(s) ?? [];
    if (!list.includes(v.rule)) list.push(v.rule);
    m.set(s, list);
  }
  return m;
}

function Args({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args ?? {});
  return (
    <>
      (
      {entries.map(([k, v], i) => (
        <span key={k}>
          <span className="tc-key">{k}</span>=<span className="tc-val">{json(v)}</span>
          {i < entries.length - 1 ? ", " : ""}
        </span>
      ))}
      )
    </>
  );
}

function Result({ result }: { result: unknown }) {
  const flat = json(result);
  if (flat.length <= 90) return <code className="tc-out">{flat}</code>;
  return <pre className="tc-out">{JSON.stringify(result, null, 2)}</pre>;
}

export function ToolCallView({ call }: { call: ToolCall }) {
  return (
    <div className={`toolcall${call.blocked ? " is-blocked" : ""}`}>
      <div className="tc-call">
        <span className="tc-name">{call.name}</span>
        <Args args={call.args} />
        {call.blocked && <Chip tone="breaks">blocked</Chip>}
      </div>
      <div className="tc-result">
        <span className="tc-arrow" aria-label="returned">
          {"↳"}
        </span>
        <Result result={call.result} />
      </div>
    </div>
  );
}

export function Transcript({
  trial,
  idPrefix = "step",
  activeStep,
  onlyRule,
  autoScroll = true,
}: {
  trial: Trial;
  idPrefix?: string;
  activeStep?: number | null;
  onlyRule?: string;
  autoScroll?: boolean;
}) {
  const flags = useMemo(() => flaggedSteps(trial.verdicts, onlyRule), [trial.verdicts, onlyRule]);
  const reduced = usePrefersReducedMotion();
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!autoScroll) return;
    const target = activeStep ?? (flags.size ? Math.min(...flags.keys()) : null);
    if (target === null || target === undefined) return;
    const el = document.getElementById(`${idPrefix}-${target}`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const explicit = activeStep !== null && activeStep !== undefined;
    if (explicit || r.top > window.innerHeight * 0.85 || r.bottom < 0) {
      el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    }
    if (explicit) el.focus({ preventScroll: true });
  }, [activeStep, flags, idPrefix, reduced, autoScroll]);

  return (
    <ol className="transcript" ref={listRef}>
      {trial.turns.map((turn, i) => {
        const rules = flags.get(i);
        const cls = ["turn", `turn-${turn.role}`, rules ? "is-flagged" : "", activeStep === i ? "is-active" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <li key={i} id={`${idPrefix}-${i}`} className={cls} tabIndex={-1}>
            <span className="turn-step" aria-label={`Step ${i}`}>
              {i}
            </span>
            <div className="turn-body">
              <div className="turn-head">
                <span className="turn-role">{ROLE[turn.role] ?? turn.role}</span>
                {rules && (
                  <span className="turn-flag">
                    {rules.join(", ")} broken here
                  </span>
                )}
                <span className="turn-t">{turn.t.toFixed(1)}s</span>
              </div>
              {turn.text && <p className="turn-text">{turn.text}</p>}
              {turn.tool_call && <ToolCallView call={turn.tool_call} />}
            </div>
          </li>
        );
      })}
      {trial.error && (
        <li className="turn turn-error">
          <span className="turn-step">!</span>
          <div className="turn-body">
            <div className="turn-head">
              <span className="turn-role">error</span>
            </div>
            <p className="turn-text mono">{trial.error}</p>
          </div>
        </li>
      )}
    </ol>
  );
}

export function VerdictList({
  verdicts,
  rules,
  onJump,
  onShowState,
  onlyRule,
}: {
  verdicts: Verdict[];
  rules: Record<string, Rule>;
  onJump?: (step: number) => void;
  onShowState?: (path: string | null) => void;
  onlyRule?: string;
}) {
  const shown = onlyRule ? verdicts.filter((v) => v.rule === onlyRule) : verdicts;
  const failed = shown.filter((v) => !v.passed && !v.error);
  const skipped = shown.filter((v) => v.error);
  const passed = shown.filter((v) => v.passed);
  return (
    <div className="verdicts">
      {failed.length > 0 && (
        <ul className="verdict-list">
          {failed.map((v, i) => {
            const step = verdictStep(v);
            const path = v.grader === "state" ? checkPath(v.check) : null;
            return (
              <li key={i} className="verdict is-fail">
                <div className="verdict-head">
                  <span className="verdict-mark" aria-hidden="true">
                    {"✕"}
                  </span>
                  <span className="mono verdict-rule">{v.rule}</span>
                  <span className="verdict-title">{rules[v.rule]?.title ?? ""}</span>
                  <Chip>{v.grader}</Chip>
                </div>
                <p className="verdict-detail">{readableDetail(v)}</p>
                <p className="verdict-check mono">{v.check}</p>
                <div className="verdict-actions">
                  {step !== null && onJump && (
                    <button type="button" className="link-btn is-accent" onClick={() => onJump(step)}>
                      go to step {step}
                    </button>
                  )}
                  {step === null && path && onShowState && (
                    <button type="button" className="link-btn is-accent" onClick={() => onShowState(path)}>
                      see final state
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {skipped.length > 0 && (
        <ul className="verdict-list is-skipped" aria-label="Checks that couldn't run">
          {skipped.map((v, i) => (
            <li key={i} className="verdict is-skip">
              <div className="verdict-head">
                <span className="verdict-mark" aria-hidden="true">
                  –
                </span>
                <span className="mono verdict-rule">{v.rule}</span>
                <span className="verdict-title">{rules[v.rule]?.title ?? ""}</span>
                <Chip tone="skip">couldn't check</Chip>
              </div>
              <p className="verdict-detail" title={v.detail}>
                The check itself couldn't run, so it doesn't count either way.
              </p>
            </li>
          ))}
        </ul>
      )}
      {passed.length > 0 && (
        <ul className="verdict-list is-passed" aria-label="Passed checks">
          {passed.map((v, i) => (
            <li key={i} className="verdict is-pass">
              <div className="verdict-head">
                <span className="verdict-mark" aria-hidden="true">
                  {"✓"}
                </span>
                <span className="mono verdict-rule">{v.rule}</span>
                <span className="verdict-title">{rules[v.rule]?.title ?? ""}</span>
                <Chip>{v.grader}</Chip>
              </div>
              <p className="verdict-check mono" title={v.detail}>
                {v.check}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The final state as a code diff. Failed state checks on paths that did not change get an "unchanged" row. */
export function StateDiff({
  diff,
  verdicts,
  idPrefix = "state",
  focusPath,
}: {
  diff: DiffEntry[];
  verdicts: Verdict[];
  idPrefix?: string;
  focusPath?: string | null;
}) {
  const failedPaths = new Map<string, Verdict>();
  for (const v of verdicts) {
    if (v.passed || v.error || v.grader !== "state") continue;
    const p = checkPath(v.check);
    if (p) failedPaths.set(p, v);
  }
  const touched = (p: string) => diff.some((d) => d.path === p || d.path.startsWith(p + ".") || d.path.startsWith(p + "["));
  const unchanged = [...failedPaths.entries()].filter(([p]) => !touched(p));
  const isFailing = (p: string) => [...failedPaths.keys()].some((fp) => p === fp || p.startsWith(fp + ".") || p.startsWith(fp + "["));

  if (!diff.length && !unchanged.length) return <p className="quiet">No state changed.</p>;
  return (
    <div className="diff" role="table" aria-label="State changes">
      {diff.map((d, i) => {
        const failing = isFailing(d.path);
        return (
          <div
            key={i}
            id={`${idPrefix}-${d.path}`}
            className={`diff-entry${failing ? " is-flagged" : ""}${focusPath && d.path.startsWith(focusPath) ? " is-active" : ""}`}
            role="row"
            tabIndex={-1}
          >
            <div className="diff-path" role="cell">
              <span className={`diff-op op-${d.op}`}>{d.op}</span> {d.path}
            </div>
            {d.op !== "add" && (
              <div className="diff-line is-del" role="cell">
                <span className="diff-sign" aria-label="before">
                  -
                </span>
                <code>{json(d.before)}</code>
              </div>
            )}
            {d.op !== "remove" && (
              <div className="diff-line is-add" role="cell">
                <span className="diff-sign" aria-label="after">
                  +
                </span>
                <code>{json(d.after)}</code>
              </div>
            )}
          </div>
        );
      })}
      {unchanged.map(([p, v]) => (
        <div
          key={p}
          id={`${idPrefix}-${p}`}
          className={`diff-entry is-flagged${focusPath === p ? " is-active" : ""}`}
          role="row"
          tabIndex={-1}
        >
          <div className="diff-path" role="cell">
            <span className="diff-op op-same">unchanged</span> {p}
          </div>
          <div className="diff-line is-same" role="cell">
            <span className="diff-sign" aria-hidden="true">
              =
            </span>
            <code>{v.detail}</code>
            <span className="diff-why">{v.rule} expected a different value</span>
          </div>
        </div>
      ))}
    </div>
  );
}
