// The simulated setup: models and default tries, the tools the agent can call, the world the tool simulator knows,
// and its seed data. All edits save directly (free); nothing runs.
import type { ReactNode } from "react";
import { parseJSON } from "../lib/draft";
import { useEditing } from "../lib/edit";
import type { Check, Defaults, Draft, ModelDefaults, ToolSpec } from "../lib/types";
import { Chip } from "./Chip";
import { ask } from "./Dialog";
import { Editable, EditToggle, useSaving } from "./Editable";

const ROLES: { k: keyof ModelDefaults; label: string; help: string; fallback: string }[] = [
  { k: "agent", label: "Agent", help: "runs your prompt", fallback: "claude-haiku-5-5" },
  { k: "user", label: "Simulated customer", help: "plays each test's customer", fallback: "claude-haiku-5-5" },
  { k: "judge", label: "Reviewer", help: "makes the judgment checks", fallback: "claude-sonnet-5-5" },
  { k: "tools", label: "Simulated tools", help: "answers the agent's tool calls", fallback: "claude-haiku-5-5" },
];

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="setup-row">
      <dt>
        {label}
        {help && <span className="quiet small setup-help">{help}</span>}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ModelsEditor() {
  const { draft, editable, update } = useEditing();
  if (!draft) return null;
  const models = draft.defaults?.models ?? {};
  const setDefaults = (fn: (x: Defaults) => Defaults) => update((d) => ({ ...d, defaults: fn(d.defaults ?? {}) }));
  return (
    <dl className="setup-list panelbox panelbox-pad">
      {ROLES.map((r) => (
        <Row key={r.k} label={r.label} help={r.help}>
          <Editable
            value={models[r.k] ?? ""}
            placeholder={`${r.fallback} (default)`}
            label={`${r.label.toLowerCase()} model`}
            className="mono"
            allowEmpty
            readOnly={!editable}
            validate={(v) => (/\s/.test(v) ? "A model id has no spaces, e.g. claude-sonnet-5-5" : null)}
            onSave={(v) =>
              setDefaults((x) => {
                const m = { ...(x.models ?? {}) };
                if (v) m[r.k] = v;
                else delete m[r.k];
                return { ...x, models: m };
              })
            }
          />
        </Row>
      ))}
      <Row label="Tries per test" help="the default when you run a check">
        <Editable
          value={draft.defaults?.k ? String(draft.defaults.k) : ""}
          placeholder="3 (default)"
          label="tries per test"
          allowEmpty
          readOnly={!editable}
          validate={(v) => (!v || (/^\d+$/.test(v) && +v >= 1 && +v <= 20) ? null : "A whole number from 1 to 20")}
          onSave={(v) =>
            setDefaults((x) => {
              const { k: _k, ...rest } = x;
              void _k;
              return v ? { ...rest, k: Number(v) } : rest;
            })
          }
        />
      </Row>
    </dl>
  );
}

/** Which checks name a tool, as "test 03, 07". */
function usesOf(d: Draft, tool: string) {
  const uses = (ch: Check) => ch.tool === tool || ch.first === tool || ch.then === tool;
  return d.cases.filter((c) => c.checks.some(uses)).map((c) => c.id);
}

const renameTool = (from: string, to: string) => (d: Draft): Draft => ({
  ...d,
  tools: d.tools.map((t) => (t.name === from ? { ...t, name: to } : t)),
  cases: d.cases.map((c) => ({
    ...c,
    checks: c.checks.map((ch) => {
      const x = { ...ch };
      for (const k of ["tool", "first", "then"]) if (x[k] === from) x[k] = to;
      return x;
    }),
  })),
});

const setTool = (name: string, patch: Partial<ToolSpec>) => (d: Draft): Draft => ({ ...d, tools: d.tools.map((t) => (t.name === name ? { ...t, ...patch } : t)) });

function ToolCard({ t }: { t: ToolSpec }) {
  const { draft, editable, update } = useEditing();
  const s = useSaving();
  const props = Object.keys(((t.input_schema as { properties?: object }).properties ?? {}) as object);
  const remove = async () => {
    const used = draft ? usesOf(draft, t.name) : [];
    if (used.length) {
      await ask({ title: `${t.name} is still checked`, body: <p>Tests {used.join(", ")} check this tool. Change or remove those checks first.</p>, confirm: "OK" });
      return;
    }
    if (await ask({ title: `Delete the tool ${t.name}?`, body: <p>The agent won't be able to call it in new checks.</p>, confirm: "Delete tool", danger: true }))
      s.run(() => update((d) => ({ ...d, tools: d.tools.filter((x) => x.name !== t.name) })));
  };
  return (
    <li className="tool tool-edit">
      <p className="tool-sig">
        <code className="tool-name">
          <Editable
            value={t.name}
            label="tool name"
            readOnly={!editable}
            validate={(v) => (!TOOL_NAME.test(v) ? "Letters, digits, _ or -" : draft?.tools.some((x) => x.name === v) ? "Another tool has that name" : null)}
            onSave={(v) => update(renameTool(t.name, v))}
          />
          <span className="quiet">({props.join(", ")})</span>
        </code>
        {t.mutates === null || t.mutates === undefined ? null : <EditToggle value={t.mutates} on={<Chip tone="flaky">changes data</Chip>} off={<Chip>read only</Chip>} label={`${t.name} changes data`} readOnly={!editable} onSave={(v) => update(setTool(t.name, { mutates: v }))} />}
        {editable && (
          <button type="button" className="link-btn quiet-btn tool-del" onClick={remove}>
            Delete
          </button>
        )}
        {s.mark}
      </p>
      <Editable value={t.description} label="what the tool does" multiline allowEmpty readOnly={!editable} placeholder="What it does, what it returns" className="tool-desc" onSave={(v) => update(setTool(t.name, { description: v }))} />
      <details className="tool-schema">
        <summary className="small quiet">Input schema (JSON)</summary>
        <Editable
          value={JSON.stringify(t.input_schema, null, 2)}
          label="input schema"
          multiline
          enter="newline"
          readOnly={!editable}
          className="mono json-edit"
          validate={(v) => {
            const [x, err] = parseJSON(v, "object");
            if (err) return err;
            const p = (x as { properties?: unknown }).properties;
            if (p !== undefined && (typeof p !== "object" || p === null || Array.isArray(p))) return "properties must be an object";
            return null;
          }}
          onSave={(v) => update(setTool(t.name, { input_schema: JSON.parse(v) }))}
        />
        {editable && <p className="quiet small">⌘/Ctrl+Enter or click away to save.</p>}
      </details>
    </li>
  );
}

export function ToolsEditor() {
  const { draft, editable, update } = useEditing();
  const s = useSaving();
  if (!draft) return null;
  const add = () =>
    s.run(() =>
      update((d) => {
        let n = 1;
        while (d.tools.some((t) => t.name === `new_tool${n > 1 ? `_${n}` : ""}`)) n++;
        return { ...d, tools: [...d.tools, { name: `new_tool${n > 1 ? `_${n}` : ""}`, description: "", input_schema: { type: "object", properties: {}, required: [] }, mutates: false }] };
      }),
    );
  return (
    <>
      {draft.tools.length ? (
        <ul className="tools">
          {draft.tools.map((t) => (
            <ToolCard key={t.name} t={t} />
          ))}
        </ul>
      ) : (
        <p className="quiet">No tools: the agent can only talk.</p>
      )}
      {editable && (
        <p className="row-actions">
          <button type="button" className="btn btn-line" onClick={add} disabled={s.busy}>
            Add a tool
          </button>
          {s.mark}
        </p>
      )}
    </>
  );
}

export function WorldEditor() {
  const { draft, editable, update } = useEditing();
  if (!draft) return null;
  return (
    <Editable
      value={draft.world}
      label="world"
      multiline
      enter="newline"
      allowEmpty
      readOnly={!editable}
      className="world-text"
      placeholder={editable ? "Plain words: what data exists, business facts the simulated tools stay consistent with." : "Nothing written."}
      onSave={(v) => update((d) => ({ ...d, world: v }))}
    />
  );
}

export function FixturesEditor() {
  const { draft, editable, update } = useEditing();
  if (!draft) return null;
  const text = Object.keys(draft.fixtures).length ? JSON.stringify(draft.fixtures, null, 2) : "";
  return (
    <>
      <Editable
        value={text}
        label="seed data"
        multiline
        enter="newline"
        allowEmpty
        readOnly={!editable}
        className="mono json-edit"
        placeholder="{ } — records the simulator must stay consistent with, as JSON"
        validate={(v) => parseJSON(v, "object")[1]}
        onSave={(v) => update((d) => ({ ...d, fixtures: (v.trim() ? JSON.parse(v) : {}) as Record<string, unknown> }))}
      />
      {editable && <p className="quiet small">⌘/Ctrl+Enter or click away to save. Must be a JSON object.</p>}
    </>
  );
}

/** The whole setup, in blocks. Used by the project's Setup tab and the new-project review. */
export function SetupSections({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const { readOnly, editable, draft } = useEditing();
  const showWorld = editable || !!draft?.world.trim() || Object.keys(draft?.fixtures ?? {}).length > 0;
  const H = `h${headingLevel}` as "h2";
  return (
    <>
      {readOnly && <p className="quiet small setup-ro">{readOnly}.</p>}
      <section className="block" aria-labelledby="setup-models">
        <H id="setup-models" className="block-h">
          Models and tries
        </H>
        <ModelsEditor />
      </section>
      <section className="block" aria-labelledby="setup-tools">
        <H id="setup-tools" className="block-h">
          Tools the agent can call
        </H>
        <ToolsEditor />
      </section>
      {showWorld && <div className="pair-blocks">
        <section className="block" aria-labelledby="setup-world">
          <H id="setup-world" className="block-h">
            What the simulated world knows
          </H>
          <div className="panelbox panelbox-pad setup-pane">
            <WorldEditor />
          </div>
        </section>
        <section className="block" aria-labelledby="setup-fixtures">
          <H id="setup-fixtures" className="block-h">
            Seed data
          </H>
          <div className="panelbox panelbox-pad setup-pane">
            <FixturesEditor />
          </div>
        </section>
      </div>}
    </>
  );
}
