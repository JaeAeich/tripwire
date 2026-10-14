"""Evidence brief: what a human or an agent needs before editing the prompt.

For each failing promise: its text, the section it comes from, the verdict, the map (attribution)
for the same prompt if one exists, a few failing conversations cut around the failing step, and the
promises that hold now (must not regress).

  b = build(run, rule="R3", runs_dir=Path("runs"))   # -> dict, b["markdown"] is the readable version
"""

from __future__ import annotations

import json
from pathlib import Path

from tripwire.compare import rule_table, variant_of
from tripwire.core.scenario import load_scenario

EXCERPTS = 3
BEFORE, AFTER = 3, 2  # turns around the failing step
CLIP = 400


def build(run: dict, rule: str | None = None, section: str | None = None, runs_dir: Path | None = None,
          excerpts: int = EXCERPTS) -> dict:
    cfg = run.get("config") or {}
    prompt = cfg.get("prompt") or {}
    rules, cases = _scenario(run)
    table = rule_table(run)
    amap = _attribution(run, runs_dir) if runs_dir else None
    matrix = (amap or {}).get("summary", {}).get("matrix", [])

    def related(rid: str) -> bool:
        if rule:
            return rid == rule
        if section:
            return (rules.get(rid, {}).get("source_section") == section
                    or any(m["rule"] == rid and m["section"] == section and m["role"] != "unclear" for m in matrix))
        return True

    failing = [r for r, x in table.items() if x["violated"] and related(r)]
    if rule and rule not in failing:
        failing = [rule]
    promises = []
    for rid in failing:
        r = rules.get(rid, {"id": rid})
        src = r.get("source_section")
        promises.append({
            "rule": rid, "title": r.get("title"), "text": r.get("text"),
            "source_section": src, "source_text": prompt.get(src) if src else None,
            "result": table.get(rid),
            "map": [{k: m.get(k) for k in ("section", "role", "base_rate", "ablated_rate", "lo", "hi", "significant",
                                           "sentence")} for m in matrix if m["rule"] == rid] or None,
            "excerpts": _excerpts(run, rid, cases, excerpts),
        })
    holding = [{"rule": rid, "title": rules.get(rid, {}).get("title"), "text": rules.get(rid, {}).get("text"),
                "sentence": x["sentence"]}
               for rid, x in table.items() if not x["violated"] and x["checked"]]
    out = {"run": run["id"], "kind": run.get("kind"), "scenario": run.get("scenario"),
           "prompt_version": cfg.get("prompt_version"), "filter": {"rule": rule, "section": section},
           "section_text": prompt.get(section) if section else None,
           "attribution_run": (amap or {}).get("id"), "promises": promises, "must_not_regress": holding}
    out["markdown"] = markdown(out)
    return out


def _scenario(run: dict) -> tuple[dict, dict]:
    cfg = run.get("config") or {}
    rules, cases = {}, {}
    path = cfg.get("scenario_path")
    if path and (Path(path) / "scenario.yaml").exists():
        scn = load_scenario(path)
        rules, cases = scn.rules, {c["id"]: c for c in scn.cases}
    cases.update({c["id"]: c for c in cfg.get("attacks") or []})
    return rules, cases


def _attribution(run: dict, runs_dir: Path) -> dict | None:
    """Latest finished map of the same scenario with the same prompt."""
    if run.get("kind") == "attribute":
        return run
    idx = Path(runs_dir) / "index.json"
    prompt = (run.get("config") or {}).get("prompt")
    for e in json.loads(idx.read_text()) if idx.exists() else []:  # newest first
        if (e["kind"] == "attribute" and e["scenario"] == run.get("scenario") and e["status"] in ("done", "stopped")
                and (e.get("config") or {}).get("prompt") == prompt):
            p = Path(runs_dir) / e["id"] / "run.json"
            if p.exists():
                return json.loads(p.read_text())
    return None


def _excerpts(run: dict, rid: str, cases: dict, n: int) -> list[dict]:
    out, seen = [], set()
    trials = [t for t in run.get("trials", []) if not t.get("error") and t.get("variant", "base") == variant_of(run)]
    # one excerpt per conversation first, so a single broken case doesn't fill the brief
    for t in sorted(trials, key=lambda t: (t["case_id"], t["trial"])):
        if len(out) >= n:
            break
        bad = [v for v in t.get("verdicts", []) if v["rule"] == rid and not v["passed"] and not v.get("error")]
        if not bad or t["case_id"] in seen:
            continue
        seen.add(t["case_id"])
        c = cases.get(t["case_id"], {})
        p = c.get("persona") or {}
        turns = t.get("turns", [])
        step = next((v["step"] for v in bad if v.get("step") is not None), None)
        lo, hi = (max(0, step - BEFORE), step + AFTER + 1) if step is not None else (max(0, len(turns) - 6), len(turns))
        out.append({"case": t["case_id"], "trial": t["trial"], "title": c.get("title"), "kind": c.get("kind"),
                    "who": p.get("who"), "goal": p.get("goal"), "angle": c.get("angle"), "step": step,
                    "turns": [_turn(i, turns[i]) for i in range(lo, min(hi, len(turns)))],
                    "failed": [{"check": v["check"], "detail": v.get("detail", "")} for v in bad]})
    return out


def _turn(i: int, u: dict) -> dict:
    tc = u.get("tool_call")
    if tc:
        return {"i": i, "role": "tool", "text": f"{tc['name']}({_clip(json.dumps(tc.get('args'), default=str))}) -> "
                                                 f"{_clip(json.dumps(tc.get('result'), default=str))}"
                                                 + (" [blocked]" if tc.get("blocked") else "")}
    return {"i": i, "role": "customer" if u["role"] == "user" else u["role"], "text": _clip(u.get("text") or "")}


def _clip(s: str, n: int = CLIP) -> str:
    return s if len(s) <= n else s[:n] + "..."


def _quote(s: str) -> str:
    return "\n".join(f"> {line}" for line in (s or "").splitlines()) or "> (empty)"


def markdown(b: dict) -> str:
    v = f", prompt v{b['prompt_version']}" if b.get("prompt_version") else ""
    lines = [f"# Brief: {b['scenario']} run {b['run']}{v}", ""]
    if b["filter"]["section"]:
        lines += [f"Section '{b['filter']['section']}':", _quote(b.get("section_text") or "(not in this prompt)"), ""]
    if not b["promises"]:
        lines += ["No failing promises" + (" for this filter." if any(b["filter"].values()) else "."), ""]
    for p in b["promises"]:
        r = p["result"]
        lines += [f"## {p['rule']} {p.get('title') or ''}".rstrip() + (f": {r['verdict']}" if r else ""), "",
                  f"Promise: {p.get('text') or '(unknown)'}", ""]
        if p["source_section"]:
            lines += [f"From section '{p['source_section']}':", _quote(p.get("source_text") or "(not in this prompt)"),
                      ""]
        lines += [f"Result: {r['sentence'] if r else 'not checked in this run'}", ""]
        if p["map"]:
            lines += [f"Map (attribution run {b['attribution_run']}), failure rate with section -> without:"]
            lines += [f"- '{m['section']}' {round(100 * m['base_rate'])}% -> {round(100 * m['ablated_rate'])}%, "
                      f"{m['role']}: {m['sentence']}" for m in p["map"]]
            lines.append("")
        elif b.get("attribution_run") is None:
            lines += ["Map: no attribution run for this prompt yet.", ""]
        for x in p["excerpts"]:
            head = f"### Case {x['case']}" + (f" '{x['title']}'" if x.get("title") else "") + \
                   (f" ({x['kind']})" if x.get("kind") else "") + f", trial {x['trial']}"
            lines += [head, ""]
            who = "; ".join(f"{k}: {x[k]}" for k in ("who", "goal", "angle") if x.get(k))
            if who:
                lines += [who, ""]
            lines += [f"- [{t['i']}] {t['role']}: {t['text']}" for t in x["turns"]]
            lines += [""] + [f"Failed check: {f['check']}" + (f": {f['detail']}" if f["detail"] else "")
                             for f in x["failed"]] + [""]
    if b["must_not_regress"]:
        lines += ["## Must not regress", ""]
        lines += [f"- {h['rule']} {h.get('title') or ''}: {h['sentence']}" for h in b["must_not_regress"]]
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
