"""Validate (and optionally repair) a Draft dict. See docs/CONTRACT.md for the shape.

repair=True (used after drafting): fix what can be fixed, drop what can't, and say what
was dropped. repair=False (used for user edits): report problems, change nothing.
"""

from __future__ import annotations

import copy
import re
from typing import Any

CHECK_TYPES = {"tool_called", "tool_not_called", "called_before", "judge", "text_matches", "text_not_matches",
               "state"}
CASE_KINDS = ("plain", "trap", "lookalike")
PERSONA_KEYS = ("who", "goal", "style", "knows", "pushback")
TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
JSON_TYPES = {"string", "number", "integer", "boolean", "object", "array", "null"}


class DraftError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")
    return s[:48].strip("-") or "scenario"


def validate_draft(draft: dict, repair: bool = True) -> tuple[dict, list[str]]:
    """Returns (draft, problems). With repair=False, raises DraftError if there are problems."""
    d = copy.deepcopy(draft or {})
    problems: list[str] = []
    note = problems.append

    d["name"] = slugify(d.get("name") or "")
    if not isinstance(d.get("description"), str):
        d["description"] = ""
    d["title"] = re.sub(r"\s+", " ", str(d.get("title") or "")).strip()[:120]
    d["defaults"] = _clean_defaults(d.get("defaults"), note)

    sections = d.get("sections")
    if not isinstance(sections, dict) or not sections:
        note("prompt has no sections")
        sections = {}
    clean_sections = {}
    for name, text in sections.items():
        name = re.sub(r"\s+", " ", str(name)).strip().lstrip("#").strip()
        if not name or not isinstance(text, str) or not text.strip():
            note(f"section {name or '(unnamed)'!r} is empty" + (", dropped" if repair else ""))
            continue
        if name == "preamble" and clean_sections:  # only the first part may go without a heading
            note("only the first section may be called 'preamble'" + (", renamed" if repair else ""))
            name = "Preamble (2)"
        if re.search(r"^##\s", text, re.M):
            note(f"section {name!r} contains a '## ' heading line; split it into its own section")
        clean_sections[name] = text.strip()
    d["sections"] = clean_sections if repair else sections

    rules, seen = [], set()
    for r in d.get("rules") or []:
        if not isinstance(r, dict) or not str(r.get("id") or "").strip() or not str(r.get("text") or "").strip():
            note("a rule without id or text" + (" was dropped" if repair else ""))
            continue
        r["id"] = str(r["id"]).strip()
        if r["id"] in seen:
            note(f"duplicate rule id {r['id']}")
            continue
        seen.add(r["id"])
        r.setdefault("title", r["id"])
        src = r.get("source_section")
        if src and src not in clean_sections:
            match = next((s for s in clean_sections if s.lower() == str(src).lower().strip()), None)
            if match:
                r["source_section"] = match
            else:
                note(f"rule {r['id']}: source section {src!r} is not a prompt section")
                if repair:
                    r["source_section"] = None
        rules.append(r)
    if not rules:
        note("no rules")
    d["rules"] = rules
    rule_ids = {r["id"] for r in rules}

    tools, tnames = [], set()
    for t in d.get("tools") or []:
        t = _clean_tool(t, note, repair)
        if t is None:
            continue
        if t["name"] in tnames:
            note(f"duplicate tool {t['name']}")
            continue
        tnames.add(t["name"])
        tools.append(t)
    d["tools"] = tools
    by_tool = {t["name"]: t for t in tools}

    if not isinstance(d.get("world"), str):
        d["world"] = ""
    if not isinstance(d.get("fixtures"), dict):
        if d.get("fixtures") not in (None, ""):
            note("fixtures must be a JSON object" + (", reset to {}" if repair else ""))
        d["fixtures"] = {}

    cases, cids = [], set()
    for i, c in enumerate(d.get("cases") or []):
        if not isinstance(c, dict):
            note(f"case #{i + 1} is not an object")
            continue
        cid = str(c.get("id") or "").strip() or f"{i + 1:02d}"
        label = f"case {cid}"
        if cid in cids:
            if not repair:
                note(f"duplicate case id {cid}")
                continue
            cid = f"{i + 1:02d}x"
        c["id"] = cid
        c["title"] = str(c.get("title") or cid)
        c["why"] = str(c.get("why") or "")
        if c.get("kind") not in CASE_KINDS:
            if c.get("kind") is not None:
                note(f"{label}: kind {c.get('kind')!r} should be one of {', '.join(CASE_KINDS)}")
            c["kind"] = "plain"
        if c.get("max_turns") is not None:
            try:
                c["max_turns"] = int(c["max_turns"])
                if not 1 <= c["max_turns"] <= 30:
                    raise ValueError
            except (TypeError, ValueError):
                note(f"{label}: max_turns must be a whole number from 1 to 30")
                c.pop("max_turns")
        else:
            c.pop("max_turns", None)
        if c.get("script") is None:
            c.pop("script", None)
        if "script" in c:
            if not isinstance(c["script"], list) or not all(isinstance(m, str) for m in c["script"]) or not c["script"]:
                note(f"{label}: script must be a list of messages")
                continue
        else:
            p = c.get("persona")
            if not isinstance(p, dict) or not str(p.get("goal") or "").strip():
                note(f"{label}: persona needs a goal" + (", dropped" if repair else ""))
                continue
            p = {k: v for k, v in p.items() if v is not None}
            try:
                p["pushback"] = max(0, min(5, int(p.get("pushback", 2))))
            except (TypeError, ValueError):
                p["pushback"] = 2
            for k in ("who", "goal", "style", "knows"):
                if k in p:
                    p[k] = str(p[k])
            c["persona"] = p
        checks = []
        for ch in c.get("checks") or []:
            ch, err = _clean_check(ch, rule_ids, by_tool, repair)
            if err:
                note(f"{label}: {err}" + (", check dropped" if repair else ""))
            if ch is not None:
                checks.append(ch)
        if not checks:
            note(f"{label}: no valid checks" + (", dropped" if repair else ""))
            if repair:
                continue
        c["checks"] = checks if repair else c.get("checks") or []
        cids.add(cid)
        cases.append(c)
    d["cases"] = cases

    tested = {ch["rule"] for c in cases for ch in c["checks"] if isinstance(ch, dict) and "rule" in ch}
    untested = [r["id"] for r in rules if r["id"] not in tested]
    d["notes"] = [str(n) for n in (d.get("notes") or []) if str(n).strip()]
    if repair and untested:
        problems.append(f"no case checks {', '.join(untested)} yet")
    if not repair:
        blocking = [p for p in problems if not p.startswith("no case checks")]
        if blocking:
            raise DraftError(blocking)
    return d, problems


MODEL_ROLES = ("agent", "user", "judge", "tools")


def _clean_defaults(x: Any, note) -> dict:
    """defaults: {models: {agent, user, judge, tools}, k}. Other keys are kept as they are."""
    if not isinstance(x, dict):
        return {}
    out = dict(x)
    models = x.get("models")
    if models is not None:
        if not isinstance(models, dict):
            note("defaults.models must be an object")
            models = {}
        bad = [str(k) for k in models if k not in MODEL_ROLES]
        if bad:
            note(f"defaults.models: unknown role {', '.join(bad)} (use {', '.join(MODEL_ROLES)})")
        out["models"] = {k: str(v).strip() for k, v in models.items() if k in MODEL_ROLES and str(v or "").strip()}
    if x.get("k") is not None:
        try:
            out["k"] = int(x["k"])
            if not 1 <= out["k"] <= 20:
                raise ValueError
        except (TypeError, ValueError):
            note("tries per test (defaults.k) must be a whole number from 1 to 20")
            out.pop("k")
    else:
        out.pop("k", None)
    return out


def _clean_tool(t: Any, note, repair: bool) -> dict | None:
    if not isinstance(t, dict) or not TOOL_NAME.match(str(t.get("name") or "")):
        note(f"tool {t.get('name') if isinstance(t, dict) else t!r}: name must be letters, digits, _ or -")
        return None
    out = {"name": t["name"], "description": str(t.get("description") or ""),
           "input_schema": t.get("input_schema"), "mutates": bool(t.get("mutates", False))}
    s = out["input_schema"]
    if not isinstance(s, dict):
        if s is not None:
            note(f"tool {t['name']}: input_schema must be an object")
        s = {}
    s = dict(s)
    s["type"] = "object"
    props = s.get("properties")
    if not isinstance(props, dict):
        props = {}
    for k, v in list(props.items()):
        if not isinstance(v, dict):
            props[k] = {"type": "string"}
            continue
        ty = v.get("type")
        types = [ty] if isinstance(ty, str) else ty if isinstance(ty, list) else []
        if ty is not None and not all(x in JSON_TYPES for x in types):
            note(f"tool {t['name']}.{k}: unknown type {ty!r}" + (", using string" if repair else ""))
            if repair:
                v["type"] = "string"
    s["properties"] = props
    req = [k for k in s.get("required") or [] if k in props]
    if len(req) != len(s.get("required") or []):
        note(f"tool {t['name']}: required lists unknown params" + (", fixed" if repair else ""))
    s["required"] = req
    out["input_schema"] = s
    return out


def _clean_check(ch: Any, rule_ids: set, tools: dict, repair: bool) -> tuple[dict | None, str | None]:
    if not isinstance(ch, dict):
        return None, "check is not an object"
    kind = ch.get("type")
    if kind not in CHECK_TYPES:
        return None, f"unknown check type {kind!r}"
    if ch.get("rule") not in rule_ids:
        return None, f"{kind} check names unknown rule {ch.get('rule')!r}"
    out = {"rule": ch["rule"], "type": kind}
    if ch.get("name"):
        out["name"] = str(ch["name"])
    if kind in ("tool_called", "tool_not_called"):
        tool = tools.get(ch.get("tool"))
        if tool is None:
            return None, f"{kind} names unknown tool {ch.get('tool')!r}"
        out["tool"] = tool["name"]
        args = ch.get("args")
        if args:
            if not isinstance(args, dict):
                return None, f"{kind} {tool['name']}: args must be an object"
            props = tool["input_schema"]["properties"]
            bad = [k for k in args if k not in props]
            if bad:
                return None, f"{kind} {tool['name']}: unknown args {bad}"
            out["args"] = {k: _coerce(v, props[k]) for k, v in args.items()}
        if kind == "tool_called" and ch.get("succeeded"):
            out["succeeded"] = True
        return out, None
    if kind == "called_before":
        for k in ("first", "then"):
            if ch.get(k) not in tools:
                return None, f"called_before: unknown tool {ch.get(k)!r}"
            out[k] = ch[k]
        return out, None
    if kind == "judge":
        crit = str(ch.get("criterion") or "").strip()
        if not crit:
            return None, "judge check needs a criterion"
        out["criterion"] = crit
        return out, None
    if kind in ("text_matches", "text_not_matches"):
        try:
            re.compile(ch.get("pattern") or "")
        except re.error as e:
            return None, f"{kind}: bad pattern ({e})"
        if not ch.get("pattern"):
            return None, f"{kind} needs a pattern"
        out["pattern"] = ch["pattern"]
        return out, None
    # state: works against the simulator's JSON state, less reliable
    if not ch.get("path"):
        return None, "state check needs a path"
    ops = [k for k in ("equals", "not_equals", "in", "count", "min_count") if k in ch]
    if not ops:
        return None, "state check needs equals / not_equals / in / count / min_count"
    out["path"] = ch["path"]
    for k in ops:
        out[k] = ch[k]
    return out, None


def _coerce(v: Any, prop: dict) -> Any:
    """Grader compares args as strings: store them the way the agent will send them."""
    ty = prop.get("type")
    if isinstance(v, str):
        try:
            if ty == "integer":
                return int(v)
            if ty == "number":
                f = float(v)
                return int(f) if f.is_integer() and "." not in v else f
            if ty == "boolean" and v.lower() in ("true", "false"):
                return v.lower() == "true"
        except ValueError:
            pass
    return v
