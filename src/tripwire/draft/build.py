"""Draft a test scenario from a system prompt (and optional tool description).

Two model steps (Sonnet by default):
1. analyze: sections (as line numbers, so the text stays verbatim), rules, tools, world, seed data, notes.
2. cases (parallel, a few rules per call): plain / trap / look-alike conversations with checks.
Then everything is validated in code; invalid parts are repaired or dropped.
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor

from tripwire.core.agent import parse_sections
from tripwire.core.backends import Backend, get_backend
from tripwire.draft import prompts
from tripwire.draft.validate import JSON_TYPES, TOOL_NAME, slugify, validate_draft

DRAFT_MODEL = "claude-sonnet-5-5"
REPAIR_MODEL = "claude-haiku-5-5"
RULES_PER_CASE_CALL = 3


def draft_scenario(prompt_text: str, tools_text: str | None = None, name: str | None = None,
                   backend: Backend | None = None, model: str = DRAFT_MODEL) -> dict:
    """Draft dict per docs/CONTRACT.md, plus cost_usd and warnings (what was repaired or dropped)."""
    if not prompt_text or not prompt_text.strip():
        raise ValueError("the prompt is empty")
    backend = backend or get_backend()
    cost = 0.0
    prompt_text = prompt_text.replace("\r\n", "\n").strip("\n")
    has_headings = bool(re.search(r"^##\s+\S", prompt_text, re.M))
    given_tools = parse_tools_json(tools_text) if tools_text else None

    # 1. analyze
    pre = parse_sections(prompt_text) if has_headings else None
    out = backend.complete_json(model=model, system=prompts.ANALYZE_SYSTEM,
                                prompt=prompts.analyze_prompt(prompt_text, tools_text, given_tools, pre),
                                schema=prompts.ANALYZE_SCHEMA)
    cost += out.cost_usd or 0.0
    a = out.data or {}
    warnings: list[str] = []
    if pre is not None:
        sections = pre
    else:
        sections = split_by_lines(prompt_text, a.get("sections") or [])
        if sections is None:
            warnings.append("model's section split was unusable; split on paragraphs instead")
            sections = split_paragraphs(prompt_text)

    rules = []
    for i, r in enumerate(a.get("rules") or []):
        rules.append({"id": f"R{i + 1}", "title": str(r.get("title") or "").strip() or f"Rule {i + 1}",
                      "text": str(r.get("text") or "").strip(), "source_section": r.get("source_section")})
    tools = given_tools if given_tools is not None else []
    mutates = {t.get("name"): bool(t.get("mutates")) for t in a.get("tools") or []}
    if given_tools is not None:
        for t in tools:
            t["mutates"] = mutates.get(t["name"], t.get("mutates", False))
    else:
        tools = [tool_from_params(t) for t in a.get("tools") or []]
    fixtures, err = _json_object(a.get("fixtures_json"))
    if err and a.get("fixtures_json"):
        # long JSON-in-a-string often has one bad comma; a cheap repair call beats losing every record
        try:
            fix = backend.complete_json(model=REPAIR_MODEL, system="You repair JSON. Change nothing else.",
                                        prompt=prompts.repair_json_prompt(a["fixtures_json"], err),
                                        schema=prompts.REPAIR_SCHEMA)
            cost += fix.cost_usd or 0.0
            fixtures, err = _json_object((fix.data or {}).get("fixtures_json"))
        except Exception as e:
            err = f"{err}; repair failed: {e}"
    if err:
        warnings.append(f"seed data was not valid JSON ({err}); started empty")

    draft = {"name": slugify(name or a.get("name") or "scenario"), "description": str(a.get("description") or ""),
             "sections": sections, "rules": rules, "tools": tools, "world": str(a.get("world") or ""),
             "fixtures": fixtures, "cases": [], "notes": [str(n) for n in a.get("notes") or []]}
    # validate before writing cases, so case calls see the final rule ids, sections and tools
    draft, problems = validate_draft(draft, repair=True)
    warnings += [p for p in problems if not p.startswith("no case checks")]

    # 2. cases, a few rules per call, in parallel
    groups = [draft["rules"][i:i + RULES_PER_CASE_CALL] for i in range(0, len(draft["rules"]), RULES_PER_CASE_CALL)]

    def write_cases(group):
        ids = [r["id"] for r in group]
        try:
            return ids, backend.complete_json(model=model, system=prompts.CASES_SYSTEM,
                                              prompt=prompts.cases_prompt(draft, ids), schema=prompts.CASES_SCHEMA)
        except Exception as e:  # one failed group shouldn't lose the whole draft
            return ids, e

    cases, failed = [], []
    with ThreadPoolExecutor(max_workers=max(1, len(groups))) as pool:
        for ids, res in pool.map(write_cases, groups):
            if isinstance(res, Exception):
                failed.append(f"writing cases for {', '.join(ids)} failed: {res}")
                continue
            cost += res.cost_usd or 0.0
            cases += [case_from_model(c) for c in (res.data or {}).get("cases") or []]
    if groups and len(failed) == len(groups):
        raise RuntimeError("drafting cases failed: " + "; ".join(failed))
    warnings += failed
    for i, c in enumerate(cases):
        c["id"] = f"{i + 1:02d}"
    draft["cases"] = cases
    draft, problems = validate_draft(draft, repair=True)
    warnings += problems
    draft["cost_usd"] = round(cost, 4)
    draft["warnings"] = warnings
    return draft


# sections

def split_by_lines(prompt_text: str, marks: list[dict]) -> dict[str, str] | None:
    """Cut the prompt at the model's start lines (1-based). Verbatim by construction; None if unusable."""
    lines = prompt_text.split("\n")
    starts: list[tuple[int, str]] = []
    for m in marks:
        try:
            n = int(m.get("start_line"))
        except (TypeError, ValueError):
            return None
        title = re.sub(r"\s+", " ", str(m.get("title") or "")).strip().lstrip("#").strip()
        if not title or not 1 <= n <= len(lines):
            return None
        starts.append((n - 1, title))
    starts.sort()
    if not starts or len({s for s, _ in starts}) != len(starts):
        return None
    if starts[0][0] != 0:
        starts.insert(0, (0, "preamble"))
    sections: dict[str, str] = {}
    for i, (s, title) in enumerate(starts):
        e = starts[i + 1][0] if i + 1 < len(starts) else len(lines)
        text = "\n".join(lines[s:e]).strip()
        if not text:
            continue
        if title in sections or title.lower() == "preamble" and i:
            title = f"{title} ({i + 1})"
        sections[title] = text
    if not sections or not same_text(prompt_text, "\n".join(sections.values())):
        return None
    return sections


def split_paragraphs(prompt_text: str, max_sections: int = 8) -> dict[str, str]:
    paras = [p.strip() for p in re.split(r"\n\s*\n", prompt_text) if p.strip()]
    per = max(1, -(-len(paras) // max_sections))
    chunks = ["\n\n".join(paras[i:i + per]) for i in range(0, len(paras), per)]
    return {f"Part {i + 1}": c for i, c in enumerate(chunks)}


def same_text(a: str, b: str) -> bool:
    norm = lambda s: re.sub(r"\s+", " ", s).strip()  # noqa: E731
    return norm(a) == norm(b)


# tools

def parse_tools_json(text: str) -> list[dict] | None:
    """Tool definitions pasted as JSON (Anthropic, OpenAI or MCP style). None if it's plain words."""
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    if isinstance(data, dict):
        data = data.get("tools") or data.get("functions") or [data]
    if not isinstance(data, list):
        return None
    out = []
    for t in data:
        if not isinstance(t, dict):
            return None
        f = t.get("function") if isinstance(t.get("function"), dict) else t
        name = f.get("name")
        if not isinstance(name, str) or not TOOL_NAME.match(name):
            return None
        schema = f.get("input_schema") or f.get("parameters") or f.get("inputSchema") or {"type": "object",
                                                                                            "properties": {}}
        out.append({"name": name, "description": str(f.get("description") or ""), "input_schema": schema,
                    "mutates": bool(t.get("mutates", False))})
    return out or None


def tool_from_params(t: dict) -> dict:
    props, req = {}, []
    for p in t.get("params") or []:
        pname = str(p.get("name") or "").strip()
        if not pname:
            continue
        ty = p.get("type") if p.get("type") in JSON_TYPES else "string"
        prop = {"type": ty}
        if p.get("description"):
            prop["description"] = str(p["description"])
        if p.get("enum"):
            prop["enum"] = [str(x) for x in p["enum"]]
        props[pname] = prop
        if p.get("required", True):
            req.append(pname)
    return {"name": str(t.get("name") or ""), "description": str(t.get("description") or ""),
            "input_schema": {"type": "object", "properties": props, "required": req},
            "mutates": bool(t.get("mutates"))}


# cases

def case_from_model(c: dict) -> dict:
    checks = []
    for ch in c.get("checks") or []:
        out = {"rule": ch.get("rule"), "type": ch.get("type")}
        for k in ("tool", "first", "then", "criterion", "pattern"):
            if ch.get(k):
                out[k] = ch[k]
        args = {a.get("name"): a.get("value") for a in ch.get("args") or [] if a.get("name")}
        if args:
            out["args"] = args
        checks.append(out)
    p = c.get("persona") or {}
    return {"title": c.get("title"), "why": c.get("why"), "kind": c.get("kind"),
            "persona": {k: p.get(k) for k in ("who", "goal", "style", "knows", "pushback") if p.get(k) is not None},
            "checks": checks}


def _json_object(text) -> tuple[dict, str | None]:
    if isinstance(text, dict):
        return text, None
    if not text:
        return {}, None
    try:
        v = json.loads(text)
    except (json.JSONDecodeError, TypeError) as e:
        return {}, str(e)
    return (v, None) if isinstance(v, dict) else ({}, "not an object")
