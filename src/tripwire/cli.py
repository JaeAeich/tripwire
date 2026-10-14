"""tripwire CLI.

  tripwire draft examples/prompts/airline.md [--tools tools.txt]   # prompt -> scenario, no Python
  tripwire eval scenarios/paylane -k 3
  tripwire attribute <run-id> -k 5
  tripwire attack scenarios/threadbare-returns --rules R3 --per-rule 3 -k 3
  tripwire brief <run-id> [--rule R3]                              # evidence for fixing the prompt
  tripwire compare <run-a> <run-b>                                 # per promise: fixed / regressed / same
  tripwire serve
  tripwire mcp                                                     # the loop as MCP tools (docs/AGENTS.md)

Long runs: launch detached so a closed terminal doesn't kill them, e.g.
  nohup uv run tripwire eval scenarios/paylane -k 5 > runs/eval.log 2>&1 &
Ctrl-C stops a run cleanly (finished trials are kept, status "stopped").
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from tripwire.core.backends import get_backend
from tripwire.core.runner import Models
from tripwire.core.scenario import load_scenario
from tripwire.core.trace import load_run


def runs_dir() -> Path:
    p = Path(os.environ.get("TRIPWIRE_RUNS", "runs")).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _progress(run):
    s = run.summary
    print(f"\r{s.get('done', 0)}/{run.config.get('total_trials')} trials  ${s.get('cost_usd', 0):.3f}", end="", flush=True)


def _run_opts(a) -> dict:
    return {"trial_timeout_s": a.trial_timeout or None, "trial_retries": a.trial_retries}


def _limits(p) -> None:
    p.add_argument("--trial-timeout", type=float, default=600,
                   help="seconds one conversation may take before it is cut off and failed (0 = no limit)")
    p.add_argument("--retries", type=int, default=2, help="retries per model call on timeouts / bad output")
    p.add_argument("--trial-retries", type=int, default=1,
                   help="reruns of a whole trial after an infra error (never after a policy failure)")


def cmd_eval(a):
    from tripwire.core.trace import Run
    from tripwire.eval import run_eval
    from tripwire.loop import affected_cases, resolve_prompt

    scn = load_scenario(a.scenario)
    models = Models.from_scenario(scn, agent=a.agent_model, user=a.user_model, judge=a.judge_model)
    try:
        cases = affected_cases(scn, a.rules, a.cases) if a.rules else a.cases
        sections, n = resolve_prompt(scn, a.prompt_version)
    except ValueError as e:
        sys.exit(str(e))
    if a.rules and not cases:
        sys.exit(f"no cases check {', '.join(a.rules)}")
    run = run_eval(scn, get_backend(a.backend, a.retries), runs_dir(), k=a.k, case_ids=cases, models=models,
                   workers=a.workers, use_judge=not a.no_judge, on_progress=_progress, sections=sections,
                   run=Run.new("eval", scn.name, {"rules": a.rules, "prompt_version": n}), **_run_opts(a))
    s = run.summary
    if not s.get("trials"):
        print(f"\n{run.id} {run.status}, no finished trials")
        return
    print(f"\n{run.id} {run.status}\npass@1 {s['pass_at_1']:.2f}  pass^{s['k']} {s['pass_hat_k']:.2f}  cost ${s['cost_usd']:.3f}")
    for rule, r in s["per_rule"].items():
        print(f"  {rule}: {r['violated']}/{r['checked']} violated")


def cmd_attribute(a):
    from tripwire.attribute import run_attribution

    base = load_run(runs_dir() / a.run / "run.json")
    scn = load_scenario(a.scenario or base["config"].get("scenario_path") or f"scenarios/{base['scenario']}")
    run = run_attribution(scn, base, get_backend(a.backend, a.retries), runs_dir(), k=a.k, sections=a.sections,
                          case_ids=a.cases, workers=a.workers, on_progress=_progress, **_run_opts(a))
    print(f"\n{run.id} {run.status}")
    for m in sorted(run.summary["matrix"], key=lambda m: m["delta"]):
        print(f"  {m['role']:12} {m['section']:24} {m['rule']:4} {m['base_rate']:.2f} -> {m['ablated_rate']:.2f}  ci {m['ci']}")


def cmd_attack(a):
    from tripwire.attack import ATTACK_MODEL, run_attack

    base = load_run(runs_dir() / a.base_run / "run.json") if a.base_run else None
    scn = load_scenario(a.scenario)
    models = Models.from_scenario(scn, agent=a.agent_model, user=a.user_model, judge=a.judge_model)
    print(f"planning attacks with {a.planner_model or ATTACK_MODEL}...", flush=True)
    run = run_attack(scn, get_backend(a.backend, a.retries), runs_dir(), rules=a.rules, per_rule=a.per_rule, k=a.k,
                     base_run=base, models=models, planner=a.planner_model or ATTACK_MODEL, workers=a.workers,
                     use_judge=not a.no_judge, on_progress=_progress, **_run_opts(a))
    s = run.summary
    print(f"\n{run.id} {run.status}  cost ${s.get('cost_usd', 0):.3f} (planning ${s.get('plan_cost_usd', 0):.3f})")
    for w in run.config.get("warnings") or []:
        print(f"  ! {w}")
    if s.get("error"):
        print(s["error"])
    for x in s.get("attacks", []) + s.get("lookalikes", []):
        tag = "PROMOTE" if x.get("promote") else ""
        print(f"  {x['id']:8} {x['kind']:9} broke {x['broke']}/{x['tries']}  {x['verdict']:8} {tag:7} {x['angle']}")
    for rule, r in s.get("per_rule", {}).items():
        print(f"  {rule}: {r['sentence']}")
    if s.get("promote"):
        print(f"candidate new tests: {', '.join(s['promote'])} (with their look-alikes); "
              f"add them in the UI or POST /api/scenarios/{scn.name}/cases")


def cmd_draft(a):
    from tripwire.draft import DRAFT_MODEL, ScenarioExists, draft_scenario, write_scenario

    prompt = Path(a.prompt_file).read_text()
    tools = Path(a.tools).read_text() if a.tools else None
    print(f"drafting with {a.model or DRAFT_MODEL} (about a minute)...", flush=True)
    d = draft_scenario(prompt, tools, name=a.name or Path(a.prompt_file).stem, backend=get_backend(a.backend, 2),
                       model=a.model or DRAFT_MODEL)
    try:
        path = write_scenario(d, a.out, overwrite=a.overwrite)
    except ScenarioExists as e:
        sys.exit(f"{e} (use --overwrite or --name)")
    kinds = {k: sum(c["kind"] == k for c in d["cases"]) for k in ("plain", "trap", "lookalike")}
    print(f"\n{path}\n{len(d['sections'])} sections, {len(d['tools'])} tools, {len(d['rules'])} rules, "
          f"{len(d['cases'])} cases ({', '.join(f'{v} {k}' for k, v in kinds.items())})  cost ${d['cost_usd']:.3f}")
    for r in d["rules"]:
        n = sum(any(ch["rule"] == r["id"] for ch in c["checks"]) for c in d["cases"])
        print(f"  {r['id']:4} {r['title']:28} {n} case(s)  [{r.get('source_section') or '?'}]")
    if d["notes"]:
        print("questions / assumptions:")
        for n in d["notes"]:
            print(f"  - {n}")
    if d.get("warnings"):
        print("fixed or dropped while validating:")
        for w in d["warnings"]:
            print(f"  - {w}")
    print(f"next: review {path}, then  tripwire eval {path} -k 1")


def cmd_ls(a):
    idx = runs_dir() / "index.json"
    for e in json.loads(idx.read_text()) if idx.exists() else []:
        print(e["id"], e["status"], json.dumps(e["headline"]))


def cmd_summarize(a):
    """Recompute a finished run's summary with the current stats code (no model calls)."""
    from tripwire.attack import summarize as attack_summary
    from tripwire.attribute import summarize as attr_summary
    from tripwire.core.trace import load_run, run_from_dict
    from tripwire.eval import summarize as eval_summary

    run = run_from_dict(load_run(runs_dir() / a.run / "run.json"))
    fn = {"eval": eval_summary, "attack": attack_summary}.get(run.kind, attr_summary)
    run.summary = {**run.summary, **fn(run)}
    run.save(runs_dir())
    s = run.summary
    print(run.id, json.dumps({k: s.get(k) for k in ("pass_at_1", "pass_hat_k", "errors", "check_errors", "cost_usd")}))


def cmd_export(a):
    """Static data for the read-only demo (GitHub Pages): index, scenarios, chosen runs."""
    import shutil

    from tripwire.server import scenarios_payload

    out = Path(a.out).resolve()
    (out / "runs").mkdir(parents=True, exist_ok=True)
    idx = json.loads((runs_dir() / "index.json").read_text())
    keep = [e for e in idx if (not a.runs or e["id"] in a.runs) and e["status"] == "done"]
    for e in keep:
        shutil.copy(runs_dir() / e["id"] / "run.json", out / "runs" / f"{e['id']}.json")
    (out / "index.json").write_text(json.dumps(keep, indent=1))
    (out / "scenarios.json").write_text(json.dumps(scenarios_payload(Path(a.scenarios).resolve()), indent=1))
    print(f"exported {len(keep)} runs to {out}")


def cmd_brief(a):
    from tripwire.brief import build

    b = build(load_run(runs_dir() / a.run / "run.json"), rule=a.rule, section=a.section, runs_dir=runs_dir(),
              excerpts=a.excerpts)
    print(json.dumps({k: v for k, v in b.items() if k != "markdown"}, indent=1) if a.json else b["markdown"])


def cmd_compare(a):
    from tripwire.compare import compare

    c = compare(load_run(runs_dir() / a.a / "run.json"), load_run(runs_dir() / a.b / "run.json"))
    if a.json:
        print(json.dumps(c, indent=1))
        return
    print(f"{c['a']} (v{c['prompt_versions'][0]}) -> {c['b']} (v{c['prompt_versions'][1]}): {c['sentence']}")
    for rule, r in c["per_rule"].items():
        print(f"  {rule:4} {r['change']:10} {r['sentence']}")


def cmd_mcp(a):
    from tripwire.server.mcp import Server

    Server(runs_dir(), Path(a.scenarios).resolve()).serve()


def cmd_serve(a):
    from tripwire.server import serve

    serve(Path(a.runs).resolve() if a.runs else runs_dir(), Path(a.scenarios).resolve(), port=a.port)


def main(argv=None):
    p = argparse.ArgumentParser(prog="tripwire")
    p.add_argument("--backend", choices=["claude-code", "anthropic"], default=None)
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("eval", help="run cases k times, report pass@1 / pass^k per rule")
    e.add_argument("scenario")
    e.add_argument("-k", type=int, default=3)
    e.add_argument("--cases", nargs="*")
    e.add_argument("--rules", nargs="*", help="only cases with checks on these promises (affected-tests rerun)")
    e.add_argument("--prompt-version", type=int, help="saved prompt version to run (default: current prompt)")
    e.add_argument("--workers", type=int, default=4)
    e.add_argument("--agent-model"); e.add_argument("--user-model"); e.add_argument("--judge-model")
    e.add_argument("--no-judge", action="store_true")
    _limits(e)
    e.set_defaults(fn=cmd_eval)

    at = sub.add_parser("attribute", help="ablate prompt sections on failing cases")
    at.add_argument("run")
    at.add_argument("--scenario")
    at.add_argument("-k", type=int, default=5)
    at.add_argument("--sections", nargs="*")
    at.add_argument("--cases", nargs="*")
    at.add_argument("--workers", type=int, default=4)
    _limits(at)
    at.set_defaults(fn=cmd_attribute)

    ak = sub.add_parser("attack", help="write customers aimed at each promise (+ harmless look-alikes), run them")
    ak.add_argument("scenario")
    ak.add_argument("--rules", nargs="*", help="promise ids to attack (default: all)")
    ak.add_argument("--per-rule", type=int, default=3, help="attacks per promise")
    ak.add_argument("-k", type=int, default=3)
    ak.add_argument("--base-run", help="eval run whose results and prompt the planner sees")
    ak.add_argument("--planner-model", help="default claude-sonnet-5-5")
    ak.add_argument("--workers", type=int, default=4)
    ak.add_argument("--agent-model"); ak.add_argument("--user-model"); ak.add_argument("--judge-model")
    ak.add_argument("--no-judge", action="store_true")
    _limits(ak)
    ak.set_defaults(fn=cmd_attack)

    dr = sub.add_parser("draft", help="draft rules, tools and test cases from a system prompt")
    dr.add_argument("prompt_file")
    dr.add_argument("--tools", help="file describing the tools: plain words or JSON tool definitions")
    dr.add_argument("--name", help="scenario name (default: the prompt file's name)")
    dr.add_argument("--out", default="scenarios", help="scenarios folder to write into")
    dr.add_argument("--model", help="drafting model (default claude-sonnet-5-5)")
    dr.add_argument("--overwrite", action="store_true")
    dr.set_defaults(fn=cmd_draft)

    ls = sub.add_parser("ls", help="list runs")
    ls.set_defaults(fn=cmd_ls)

    sm = sub.add_parser("summarize", help="recompute a run's summary with the current stats (free)")
    sm.add_argument("run")
    sm.set_defaults(fn=cmd_summarize)

    ex = sub.add_parser("export", help="write static demo data for the web UI")
    ex.add_argument("--out", default="web/public/data")
    ex.add_argument("--runs", nargs="*")
    ex.add_argument("--scenarios", default="scenarios")
    ex.set_defaults(fn=cmd_export)

    br = sub.add_parser("brief", help="evidence brief for fixing the prompt (failing promises, map, excerpts)")
    br.add_argument("run")
    br.add_argument("--rule")
    br.add_argument("--section")
    br.add_argument("--excerpts", type=int, default=3, help="failing conversations per promise")
    br.add_argument("--json", action="store_true")
    br.set_defaults(fn=cmd_brief)

    cp = sub.add_parser("compare", help="per promise before (a) / after (b)")
    cp.add_argument("a"); cp.add_argument("b")
    cp.add_argument("--json", action="store_true")
    cp.set_defaults(fn=cmd_compare)

    mc = sub.add_parser("mcp", help="MCP server (stdio) exposing the improve loop to coding agents")
    mc.add_argument("--scenarios", default="scenarios")
    mc.set_defaults(fn=cmd_mcp)

    sv = sub.add_parser("serve", help="API + UI")
    sv.add_argument("--port", type=int, default=8787)
    sv.add_argument("--scenarios", default="scenarios")
    sv.add_argument("--runs", default=None, help="runs folder (default: $TRIPWIRE_RUNS or runs)")
    sv.set_defaults(fn=cmd_serve)

    a = p.parse_args(argv)
    if a.backend:  # simulated tools build their own backend with get_backend(); keep it the same
        os.environ["TRIPWIRE_BACKEND"] = a.backend
    a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
