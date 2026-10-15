// Where in the prompt does a promise live? Used to pin promises in the margin next to the part (and sentence)
// they come from. Drafted projects say it (source_section); older ones are matched by words.
import type { Rule } from "./types";

const STOP = new Set(
  "the and for that this with from have your you are not but can any all only them they their when what then than into also more most must never always should would will just about after before over under been does said says".split(
    " ",
  ),
);

const stem = (w: string) => w.slice(0, 5);

export function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9$]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
}

/** Split a paragraph into sentences, keeping the exact text so they can be rendered back in order. */
export function sentences(text: string): string[] {
  const out = text.match(/[^.!?\n]+(?:[.!?]+["”’)]?|\n|$)\s*/g) ?? [text];
  return out.filter((s) => s.length > 0);
}

function score(a: string[], b: Set<string>): number {
  if (!a.length) return 0;
  let hit = 0;
  for (const w of new Set(a)) if (b.has(w)) hit++;
  return hit;
}

/** Index of the sentence in `text` that best matches the rule, or null if nothing matches well. */
export function bestSentence(text: string, rule: Pick<Rule, "title" | "text">): number | null {
  const rw = new Set(words(`${rule.title} ${rule.text}`));
  const ss = sentences(text);
  let best = -1;
  let bestScore = 0;
  ss.forEach((s, i) => {
    const hits = score(words(s), rw);
    // one shared word ("customer") is a coincidence, not a match
    const sc = hits < 2 ? 0 : hits / Math.sqrt(Math.max(8, words(s).length));
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  });
  return best >= 0 && bestScore >= 0.5 ? best : null;
}

/** The section each rule belongs to. Rules we can't place map to null ("the whole prompt"). */
export function placeRules(sections: Record<string, string>, rules: Rule[]): Record<string, string | null> {
  const names = Object.keys(sections);
  const out: Record<string, string | null> = {};
  for (const r of rules) {
    if (r.source_section && names.includes(r.source_section)) {
      out[r.id] = r.source_section;
      continue;
    }
    // a section named like the promise ("Refunds" for "Refund policy")
    const tw = new Set(words(r.title));
    const byName = names.find((n) => n !== "preamble" && words(n).some((w) => tw.has(w)));
    if (byName) {
      out[r.id] = byName;
      continue;
    }
    // else the section with the best-matching sentence
    const rw = new Set(words(`${r.title} ${r.text}`));
    let best: string | null = null;
    let bestScore = 0;
    for (const n of names) {
      const sc = Math.max(0, ...sentences(sections[n]).map((s) => score(words(s), rw) / Math.sqrt(Math.max(4, words(s).length))));
      if (sc > bestScore) {
        bestScore = sc;
        best = n;
      }
    }
    out[r.id] = bestScore >= 0.8 ? best : null;
  }
  return out;
}

/** "## Heading" splits a pasted prompt into parts, for previews before the server does it properly. */
export function splitPrompt(prompt: string): Record<string, string> {
  const out: Record<string, string> = {};
  let name = "preamble";
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) out[name] = t;
  };
  for (const line of prompt.split("\n")) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1];
      buf = [];
    } else buf.push(line);
  }
  flush();
  return out;
}
