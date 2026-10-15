#!/usr/bin/env node
// Save a read-only snapshot for the static demo (GitHub Pages).
//   uv run tripwire serve            # in the repo root
//   pnpm snapshot [--api http://127.0.0.1:8787] [--out public/data] [--all]
// Writes <out>/index.json, <out>/scenarios.json and <out>/runs/<id>.json.
// Only finished runs are saved unless --all is given.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const api = opt("--api", "http://127.0.0.1:8787").replace(/\/$/, "");
const out = opt("--out", "public/data");
const all = args.includes("--all");

async function get(path) {
  const r = await fetch(api + path);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${r.statusText}`);
  return r.json();
}

try {
  await get("/api/health");
} catch (e) {
  console.error(`No tripwire API at ${api}. Start it with: uv run tripwire serve`);
  process.exit(1);
}

const [index, scenarios] = await Promise.all([get("/api/runs"), get("/api/scenarios")]);
const keep = index.filter((r) => all || r.status === "done");
await mkdir(join(out, "runs"), { recursive: true });
for (const r of keep) {
  const run = await get(`/api/runs/${encodeURIComponent(r.id)}`);
  await writeFile(join(out, "runs", `${r.id}.json`), JSON.stringify(run));
  console.log(`  ${r.id}  ${r.kind}  ${run.trials.length} trials`);
}
await writeFile(join(out, "index.json"), JSON.stringify(keep, null, 1));
await writeFile(join(out, "scenarios.json"), JSON.stringify(scenarios, null, 1));
console.log(`${keep.length} runs, ${scenarios.length} scenarios -> ${out}`);
