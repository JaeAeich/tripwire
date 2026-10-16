// One test, every part of it editable in place: why, kind, the simulated customer (or the scripted messages), how
// long the conversation may go, and the checks. Saving is free: nothing runs until someone asks for a check.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CHECK_SPECS, checkProblem, duplicateCase, deleteCase, parseJSON, retypeCheck, setCase, STATE_OP_WORDS, STATE_OPS, type StateOp } from "../lib/draft";
import { useEditing, type Editing } from "../lib/edit";
import type { CaseKind, Check, DraftCase, Persona, Rule, ToolSpec } from "../lib/types";
import { checkSentence, KIND_WORDS } from "../lib/words";
import { Chip } from "./Chip";
import { KindBadge } from "./promise";
import { ask } from "./Dialog";
import { Editable, EditSelect, EditToggle, PENDING, useSaving } from "./Editable";

const PUSHBACK = ["not at all", "a little", "firmly", "hard, several times", "very hard", "won't take no"];
const DEFAULT_TURNS = 6;

export const KIND_OPTIONS: { value: CaseKind; label: string }[] = (["plain", "trap", "lookalike"] as CaseKind[]).map((k) => ({ value: k, label: KIND_WORDS[k].label }));

/** The kind chip, editable. */
export function KindPick({ c }: { c: DraftCase }) {
  const { editable, update } = useEditing();
  return (
    <span className="chip chip-neutral chip-pick" title={KIND_WORDS[c.kind]?.help}>
      <EditSelect value={c.kind} options={KIND_OPTIONS} label={`test ${c.id} kind`} readOnly={!editable} onSave={(v) => update(setCase(c.id, (x) => ({ ...x, kind: v })))} />
    </span>
  );
}

/** The test's title, editable. */
export function TestTitle({ c }: { c: DraftCase }) {
  const { editable, update } = useEditing();
  return <Editable value={c.title} label="test name" readOnly={!editable} onSave={(v) => update(setCase(c.id, (x) => ({ ...x, title: v })))} />;
}

/** Duplicate / delete, with a confirm for delete. */
export function useTestActions() {
  return testActionsWith(useEditing());
}

export function testActionsWith({ update }: Editing) {
  return {
    duplicate: (id: string) => update(duplicateCase(id)),
    remove: async (c: DraftCase) => {
      const ok = await ask({ title: `Delete test “${c.title}”?`, body: <p>Old reports keep its results; new checks won't run it.</p>, confirm: "Delete test", danger: true });
      if (ok) await update(deleteCase(c.id));
      return ok;
    },
  };
}

/** A test in a list: closed it reads as a row; open, every part of it is editable, with duplicate and delete. */
export function TestRow({
  c,
  rules,
  tools,
  extra,
  startOpen = false,
}: {
  c: DraftCase;
  rules: Rule[];
  tools: ToolSpec[];
  extra?: ReactNode;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const e = useEditing();
  const act = useTestActions();
  const s = useSaving();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (startOpen) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [startOpen]);
  return (
    <li ref={ref} className={`tcase tcase-edit${open ? " is-open" : ""}`} id={`test-${c.id}`}>
      <div className="tcase-head">
        {open ? (
          <>
            <button type="button" className="tcase-toggle tcase-caret-btn" aria-expanded aria-label={`Close test ${c.title}`} onClick={() => setOpen(false)}>
              <span className="tcase-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            <KindPick c={c} />
            <span className="tcase-title">
              <TestTitle c={c} />
            </span>
          </>
        ) : (
          <button type="button" className="tcase-toggle" aria-expanded={false} onClick={() => setOpen(true)}>
            <span className="tcase-caret" aria-hidden="true">
              ▸
            </span>
            <KindBadge kind={c.kind} />
            <span className="tcase-title">{c.title}</span>
          </button>
        )}
        {extra}
      </div>
      {open && (
        <div className="tcase-body">
          <TestBody c={c} rules={rules} tools={tools} />
          {e.editable && (
            <p className="row-actions tcase-actions">
              <button type="button" className="link-btn" onClick={() => s.run(() => act.duplicate(c.id))}>
                Duplicate
              </button>
              <button type="button" className="link-btn quiet-btn" onClick={() => act.remove(c)}>
                Delete test…
              </button>
              {s.mark}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function TestBody({ c, rules, tools }: { c: DraftCase; rules: Rule[]; tools: ToolSpec[] }) {
  const { editable, update } = useEditing();
  const save = (fn: (x: DraftCase) => DraftCase) => update(setCase(c.id, fn));
  const setPersona = (k: keyof Persona, v: unknown) => save((x) => ({ ...x, persona: { ...(x.persona ?? {}), [k]: v } }));
  const p = c.persona ?? {};
  const scripted = Array.isArray(c.script);
  const rows: [keyof Persona, string, string][] = [
    ["who", "Who", "Who they are, e.g. Maya, returning a sweater"],
    ["goal", "Wants", "What they want from the agent"],
    ["style", "How they talk", "Polite, brief; angry; rambling…"],
    ["knows", "Knows", "Order numbers, emails, facts they can give"],
  ];
  return (
    <div className="tedit">
      <div className="tedit-why">
        <Editable value={c.why ?? ""} label="why this test matters" multiline allowEmpty readOnly={!editable} placeholder="Why this test matters (optional)" className="tcase-why" onSave={(v) => save((x) => ({ ...x, why: v }))} />
      </div>

      <p className="label">{scripted ? "The customer says, in order" : "The simulated customer"}</p>
      {scripted ? (
        <Script c={c} />
      ) : (
        <dl className="persona persona-edit">
          {rows.map(([k, label, ph]) => (
            <div key={k}>
              <dt>{label}</dt>
              <dd>
                <Editable value={String(p[k] ?? "")} label={label.toLowerCase()} multiline allowEmpty={k !== "goal"} placeholder={ph} readOnly={!editable} onSave={(v) => setPersona(k, v)} />
              </dd>
            </div>
          ))}
          <div>
            <dt>Pushes back</dt>
            <dd>
              <EditSelect
                value={String(p.pushback ?? 2)}
                label="how hard they push back"
                readOnly={!editable}
                options={PUSHBACK.map((w, i) => ({ value: String(i), label: `${i} · ${w}` }))}
                onSave={(v) => setPersona("pushback", Number(v))}
              />
            </dd>
          </div>
        </dl>
      )}
      <dl className="persona persona-edit">
        <div>
          <dt>Longest</dt>
          <dd>
            <Editable
              value={c.max_turns ? String(c.max_turns) : ""}
              display={`${c.max_turns} customer turns`}
              placeholder={`${DEFAULT_TURNS} customer turns (default)`}
              label="most customer turns"
              allowEmpty
              readOnly={!editable}
              validate={(v) => (!v || (/^\d+$/.test(v) && +v >= 1 && +v <= 30) ? null : "A whole number from 1 to 30")}
              onSave={(v) =>
                save((x) => {
                  const { max_turns: _m, ...rest } = x;
                  void _m;
                  return v ? { ...rest, max_turns: Number(v) } : rest;
                })
              }
            />
          </dd>
        </div>
      </dl>

      <p className="label">It passes if</p>
      <ul className="check-edit">
        {c.checks.map((ch, i) => (
          <CheckRow key={`${i}-${ch.type}`} c={c} i={i} ch={ch} rules={rules} tools={tools} />
        ))}
      </ul>
      {editable && <AddCheck c={c} rules={rules} tools={tools} />}
    </div>
  );
}

function Script({ c }: { c: DraftCase }) {
  const { editable, update } = useEditing();
  const lines = c.script ?? [];
  const s = useSaving();
  const set = (next: string[]) => update(setCase(c.id, (x) => ({ ...x, script: next })));
  return (
    <>
      <ol className="script script-edit">
        {lines.map((l, i) => (
          <li key={i}>
            <Editable value={l} label={`customer message ${i + 1}`} multiline readOnly={!editable} onSave={(v) => set(lines.map((x, j) => (j === i ? v : x)))} />
            {editable && lines.length > 1 && (
              <button type="button" className="icon-btn" aria-label={`Remove message ${i + 1}`} title="Remove this message" onClick={() => s.run(() => set(lines.filter((_, j) => j !== i)))}>
                ×
              </button>
            )}
          </li>
        ))}
      </ol>
      {editable && (
        <p className="row-actions">
          <button type="button" className="link-btn" onClick={() => s.run(() => set([...lines, "…"]))}>
            + Add a message
          </button>
          {s.mark}
        </p>
      )}
    </>
  );
}

function AddCheck({ c, rules, tools }: { c: DraftCase; rules: Rule[]; tools: ToolSpec[] }) {
  const { update } = useEditing();
  const s = useSaving();
  const rule = c.checks[0]?.rule ?? rules[0]?.id;
  const r = rules.find((x) => x.id === rule);
  if (!r) return null;
  const fresh: Check = { rule: r.id, type: "judge", criterion: `Did the agent keep this promise: ${r.text.replace(/\.$/, "")}?` };
  void tools;
  return (
    <p className="row-actions">
      <button type="button" className="link-btn" onClick={() => s.run(() => update(setCase(c.id, (x) => ({ ...x, checks: [...x.checks, fresh] }))))}>
        + Add a check
      </button>
      {s.mark}
    </p>
  );
}

/** One check: promise, type, and the type's own fields. A check that isn't complete yet stays here until it is. */
function CheckRow({ c, i, ch, rules, tools }: { c: DraftCase; i: number; ch: Check; rules: Rule[]; tools: ToolSpec[] }) {
  const { editable, update } = useEditing();
  const [pending, setPending] = useState<Check | null>(null);
  const s = useSaving();
  const cur = pending ?? ch;
  const toolNames = tools.map((t) => t.name);
  const ruleIds = rules.map((r) => r.id);
  const spec = CHECK_SPECS.find((x) => x.type === cur.type);
  const problem = checkProblem(cur, toolNames, ruleIds);

  /** Save the check if it's complete; otherwise keep it here, unsaved, and say what's missing. */
  const put = async (next: Check) => {
    if (checkProblem(next, toolNames, ruleIds)) {
      setPending(next);
      return PENDING;
    }
    await update(setCase(c.id, (x) => ({ ...x, checks: x.checks.map((y, j) => (j === i ? next : y)) })));
    setPending(null);
  };
  const remove = () => s.run(() => update(setCase(c.id, (x) => ({ ...x, checks: x.checks.filter((_, j) => j !== i) }))));
  const field = (k: string, v: unknown) => put({ ...cur, [k]: v });
  const toolOpts = toolNames.map((t) => ({ value: t, label: t }));
  const ro = !editable;

  const argsOf = (tool: string) => Object.keys(((tools.find((t) => t.name === tool)?.input_schema as { properties?: object })?.properties ?? {}) as object);
  const argsField = (
    <Editable
      value={cur.args && Object.keys(cur.args as object).length ? JSON.stringify(cur.args) : ""}
      label="arguments"
      allowEmpty
      readOnly={ro}
      className="mono"
      placeholder="any arguments"
      validate={(v) => {
        if (!v) return null;
        const [x, err] = parseJSON(v, "object");
        if (err) return err;
        const bad = Object.keys(x as object).filter((k) => !argsOf(String(cur.tool)).includes(k));
        return bad.length ? `${cur.tool} has no ${bad.join(", ")} (it takes ${argsOf(String(cur.tool)).join(", ") || "nothing"})` : null;
      }}
      onSave={(v) => {
        const { args: _a, ...rest } = cur;
        void _a;
        return put(v ? { ...rest, args: JSON.parse(v) } : rest);
      }}
    />
  );

  let body = null;
  switch (cur.type) {
    case "tool_called":
    case "tool_not_called":
      body = (
        <>
          <EditSelect value={String(cur.tool ?? "")} options={[...(toolNames.includes(String(cur.tool)) ? [] : [{ value: String(cur.tool ?? ""), label: "pick a tool" }]), ...toolOpts]} label="tool" readOnly={ro} className="mono" onSave={(v) => field("tool", v)} />
          <span className="quiet">with</span>
          {argsField}
          {cur.type === "tool_called" && (
            <EditToggle value={!!cur.succeeded} on={<span className="small">and it succeeds</span>} off={<span className="small quiet">success not required</span>} label="must the call succeed" readOnly={ro} onSave={(v) => put(v ? { ...cur, succeeded: true } : (({ succeeded: _s, ...rest }) => (void _s, rest))(cur))} />
          )}
        </>
      );
      break;
    case "called_before":
      body = (
        <>
          <EditSelect value={String(cur.first ?? "")} options={toolOpts} label="first tool" readOnly={ro} className="mono" onSave={(v) => field("first", v)} />
          <span className="quiet">before</span>
          <EditSelect value={String(cur.then ?? "")} options={toolOpts} label="then tool" readOnly={ro} className="mono" onSave={(v) => field("then", v)} />
        </>
      );
      break;
    case "judge":
      body = <Editable value={String(cur.criterion ?? "")} label="what the reviewer checks" multiline readOnly={ro} placeholder="Did the agent …?" autoEdit={!!pending && !cur.criterion} onSave={(v) => field("criterion", v)} />;
      break;
    case "text_matches":
    case "text_not_matches":
      body = (
        <Editable
          value={String(cur.pattern ?? "")}
          label="pattern"
          readOnly={ro}
          className="mono"
          placeholder="a regular expression, e.g. refund(ed)? today"
          autoEdit={!!pending && !cur.pattern}
          validate={(v) => {
            try {
              new RegExp(v);
              return null;
            } catch {
              return "Not a valid regular expression";
            }
          }}
          onSave={(v) => field("pattern", v)}
        />
      );
      break;
    case "state": {
      const op = (STATE_OPS.find((k) => k in cur) ?? "equals") as StateOp;
      body = (
        <>
          <Editable value={String(cur.path ?? "")} label="data path" readOnly={ro} className="mono" placeholder="orders.TB-1001.status" autoEdit={!!pending && !cur.path} onSave={(v) => field("path", v)} />
          <EditSelect
            value={op}
            options={STATE_OPS.map((k) => ({ value: k, label: STATE_OP_WORDS[k] }))}
            label="comparison"
            readOnly={ro}
            onSave={(v) => {
              const val = cur[op];
              const next: Check = { rule: cur.rule, type: "state", path: cur.path };
              next[v] = v === "count" || v === "min_count" ? (typeof val === "number" ? val : 1) : v === "in" ? (Array.isArray(val) ? val : [val ?? ""]) : (val ?? "");
              return put(next);
            }}
          />
          <Editable
            value={JSON.stringify(cur[op] ?? "")}
            label="value (JSON)"
            readOnly={ro}
            className="mono"
            validate={(v) => {
              const [x, err] = parseJSON(v);
              if (err) return err;
              if ((op === "count" || op === "min_count") && !(Number.isInteger(x) && (x as number) >= 0)) return "A whole number";
              if (op === "in" && !Array.isArray(x)) return 'A JSON list, e.g. ["refunded", "closed"]';
              return null;
            }}
            onSave={(v) => field(op, JSON.parse(v))}
          />
        </>
      );
      break;
    }
    default:
      body = <span className="quiet">{checkSentence(cur)}</span>;
  }

  return (
    <li className={`check-row${pending ? " is-pending" : ""}`}>
      <span className="check-what">
        <EditSelect value={cur.rule} options={rules.map((r) => ({ value: r.id, label: r.id }))} label="which promise this checks" readOnly={ro} className="rule-ref" onSave={(v) => field("rule", v)} />
        <EditSelect
          value={cur.type}
          options={[...(spec ? [] : [{ value: cur.type, label: cur.type }]), ...CHECK_SPECS.map((x) => ({ value: x.type, label: x.label }))]}
          label="kind of check"
          readOnly={ro}
          onSave={(v) => put(retypeCheck(cur, v, toolNames))}
        />
        <Chip title={spec?.grader === "judgment" ? "checked by a reviewer model" : "checked by code"}>{spec?.grader ?? "exact"}</Chip>
        {editable && (
          <span className="check-tools">
            {pending && (
              <button type="button" className="link-btn quiet-btn" onClick={() => setPending(null)}>
                Undo
              </button>
            )}
            {c.checks.length > 1 ? (
              <button type="button" className="icon-btn" aria-label="Remove this check" title="Remove this check" onClick={remove}>
                ×
              </button>
            ) : null}
          </span>
        )}
      </span>
      <span className="check-how">{body}</span>
      {pending && problem && <span className="check-missing small">{problem} to save this check.</span>}
      {s.mark}
    </li>
  );
}
