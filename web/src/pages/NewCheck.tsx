// Step 1: a blank page to paste the prompt on. While we draft, the prompt stays on the page and the margin says what we're doing.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { draftPrompt, MOCK } from "../lib/api";
import { splitPrompt } from "../lib/anchor";
import { useAppData } from "../lib/context";
import { putDraft } from "../lib/draftStore";
import { RETURNS_PROMPT, RETURNS_TOOLS_TEXT } from "../lib/example";
import { dur } from "../lib/format";
import { useDocumentTitle, useNow } from "../lib/hooks";
import { HotProvider, PromptDoc } from "../components/Doc";
import { FlowSteps } from "../components/promise";
import { Help } from "../components/Stats";

/** What the drafter is roughly doing at each point. It's one request, so this is a guide, not a live feed. */
const STAGES: { from: number; text: string }[] = [
  { from: 0, text: "Reading your prompt and splitting it into parts" },
  { from: 12, text: "Listing the promises it makes" },
  { from: 35, text: "Working out the tools and data the agent needs" },
  { from: 55, text: "Writing test conversations: ordinary ones, traps and look-alikes" },
  { from: 90, text: "Deciding how to check each test, by code where possible" },
];

function Drafting({ started, onCancel }: { started: number; onCancel: () => void }) {
  const now = useNow(500);
  const s = (now - started) / 1000;
  const at = STAGES.filter((x) => s >= x.from).length - 1;
  return (
    <div className="note note-drafting" aria-live="polite">
      <p className="note-top">
        <span className="pulse" aria-hidden="true" />
        <span className="note-verb">Drafting</span>
        <span className="quiet note-t">{dur(s)}</span>
      </p>
      <ol className="stages">
        {STAGES.map((x, i) => (
          <li key={x.text} className={i < at ? "is-done" : i === at ? "is-now" : ""}>
            {x.text}
          </li>
        ))}
      </ol>
      <p className="quiet small">
        {s > 150 ? "Taking longer than usual. Long prompts can take up to 3 minutes." : "Usually 30 seconds to 2 minutes, about $0.05."} Nothing runs against your agent yet.
      </p>
      <button type="button" className="btn btn-line btn-sm" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function NewCheck() {
  useDocumentTitle("Check a prompt");
  const nav = useNavigate();
  const { mode } = useAppData();
  const [params] = useSearchParams();
  const [prompt, setPrompt] = useState("");
  const [tools, setTools] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const useExample = () => {
    setPrompt(RETURNS_PROMPT);
    setTools(RETURNS_TOOLS_TEXT);
    setName("kettle-returns");
  };

  const run = async () => {
    if (!prompt.trim()) return;
    const ac = new AbortController();
    abort.current = ac;
    setErr(null);
    setBusy(Date.now());
    try {
      const d = await draftPrompt({ prompt, tools: tools.trim() || undefined, name: name.trim() || undefined }, ac.signal);
      putDraft(d);
      nav("/check/review");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      setBusy(null);
    }
  };

  // ?example=1 prefills the example; ?autostart=1 (mock only) also submits, for screenshots
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current) return;
    if (params.get("example")) {
      auto.current = true;
      useExample();
      if (MOCK && params.get("autostart")) setTimeout(() => document.querySelector<HTMLButtonElement>("#draft-btn")?.click(), 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => () => abort.current?.abort(), []);

  // grow the page with the text, like a document
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(420, el.scrollHeight + 4)}px`;
  }, [prompt, busy]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run();
  };

  const parts = splitPrompt(prompt);
  const headings = Object.keys(parts).filter((p) => p !== "preamble").length;
  const words = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;

  if (busy !== null)
    return (
      <div className="page">
        <header className="dochead">
          <FlowSteps at={1} />
          <h1 className="doc-title">{name || "Your prompt"}</h1>
          <p className="doc-sub">We're reading it. Promises will appear in the margin next to the part they come from.</p>
        </header>
        <article className="sheet is-reading">
          <HotProvider>
            <PromptDoc
              sections={parts}
              margin={(n) =>
                n === Object.keys(parts)[0] ? (
                  <Drafting
                    started={busy}
                    onCancel={() => {
                      abort.current?.abort();
                      setBusy(null);
                    }}
                  />
                ) : (
                  <span className="ghost-note" aria-hidden="true" />
                )
              }
            />
          </HotProvider>
        </article>
      </div>
    );

  return (
    <form className="page" onSubmit={submit}>
      <header className="dochead">
        <FlowSteps at={1} />
        <input
          className="doc-title doc-title-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Untitled agent"
          aria-label="Project name (optional)"
        />
        <p className="doc-sub">
          Paste your agent's system prompt. You review every promise and test before anything runs.
        </p>
      </header>


      <div className="compose">
        <div className="sheet compose-sheet">
          <textarea
            ref={area}
            className="compose-area"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={"You are the support agent for Acme…\n\n## Refunds\nRefund orders under $50 automatically…"}
            aria-label="System prompt"
            required
          />
          {!prompt && (
            <button type="button" className="compose-example" onClick={useExample}>
              Or start with an example: a homeware store's returns agent
            </button>
          )}
        </div>

        <aside className="compose-margin">
          <div className="note note-plain">
            <p className="note-title">{words ? `${words} words, ${headings ? plural(headings, "part") : "no parts yet"}` : "Your prompt, in parts"}</p>
            <p className="note-text">
              Split it with <code>## Heading</code> lines{" "}
              <Help>The map takes out one part at a time to see which part each promise depends on. No headings? We'll split it for you.</Help>
            </p>
            {headings > 0 && (
              <ul className="parts-mini">
                {Object.keys(parts)
                  .filter((p) => p !== "preamble")
                  .map((p) => (
                    <li key={p}>{p}</li>
                  ))}
              </ul>
            )}
          </div>
          <label className="note note-plain">
            <span className="note-title">
              Tools the agent can call <span className="quiet">optional</span>
            </span>
            <textarea
              className="margin-input"
              rows={6}
              value={tools}
              onChange={(e) => setTools(e.target.value)}
              placeholder={"lookup_order(order_id, email): finds an order\nissue_refund(order_id, amount)"}
            />
            <span className="note-text">
              Plain words or JSON <Help>We simulate the tools, so nothing real is called. Leave it empty and we'll guess them from the prompt.</Help>
            </span>
          </label>
          <div className="compose-go">
            <button id="draft-btn" type="submit" className="btn btn-ink btn-lg" disabled={!prompt.trim() || mode === "static"}>
              Draft the promises
            </button>
            <p className="quiet small">{mode === "static" ? "Read-only demo: run tripwire locally" : "30 s to 2 min · about $0.05"}</p>
            {err && <p className="form-error">Drafting failed: {err}</p>}
          </div>
        </aside>
      </div>
    </form>
  );
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}
