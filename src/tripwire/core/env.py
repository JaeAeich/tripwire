"""Environment contract: tools are methods, state is JSON that we snapshot and diff."""

from __future__ import annotations

import copy
from typing import Any, Callable


def tool(description: str, params: dict[str, dict], required: list[str] | None = None):
    """Mark an Environment method as a tool the agent can call.

    params uses JSON-schema property definitions, e.g. {"email": {"type": "string"}}.
    """

    def wrap(fn: Callable) -> Callable:
        fn.__tool__ = {
            "name": fn.__name__,
            "description": description,
            "input_schema": {
                "type": "object",
                "properties": params,
                "required": list(params) if required is None else required,
                "additionalProperties": False,
            },
        }
        return fn

    return wrap


class Environment:
    """Subclass per scenario. Keep everything the graders need inside self.state."""

    def __init__(self, fixtures: dict):
        self.state: dict[str, Any] = copy.deepcopy(fixtures)

    @classmethod
    def tool_specs(cls) -> list[dict]:
        return [getattr(cls, n).__tool__ for n in dir(cls) if hasattr(getattr(cls, n, None), "__tool__")]

    def call(self, name: str, args: dict) -> tuple[Any, bool]:
        """Run a tool. Returns (result, blocked)."""
        fn = getattr(self, name, None)
        if fn is None or not hasattr(fn, "__tool__"):
            return {"error": f"unknown tool {name}"}, True
        try:
            result = fn(**args)
        except TypeError as e:  # wrong or missing arguments from the model
            return {"error": f"bad arguments: {e}"}, True
        blocked = isinstance(result, dict) and (result.get("ok") is False or "error" in result)
        return result, blocked

    def snapshot(self) -> dict:
        return copy.deepcopy(self.state)


def diff(before: Any, after: Any, path: str = "") -> list[dict]:
    """Structural diff of two JSON values. Lists of dicts with an "id" are matched by id."""
    out: list[dict] = []
    if isinstance(before, dict) and isinstance(after, dict):
        for k in sorted(set(before) | set(after)):
            p = f"{path}.{k}" if path else k
            if k not in before:
                out.append({"path": p, "op": "add", "after": after[k]})
            elif k not in after:
                out.append({"path": p, "op": "remove", "before": before[k]})
            else:
                out += diff(before[k], after[k], p)
    elif isinstance(before, list) and isinstance(after, list) and _keyed(before) and _keyed(after):
        b, a = {x["id"]: x for x in before}, {x["id"]: x for x in after}
        for k in sorted(set(b) | set(a)):
            p = f"{path}[id={k}]"
            if k not in b:
                out.append({"path": p, "op": "add", "after": a[k]})
            elif k not in a:
                out.append({"path": p, "op": "remove", "before": b[k]})
            else:
                out += diff(b[k], a[k], p)
    elif before != after:
        out.append({"path": path, "op": "change", "before": before, "after": after})
    return out


def _keyed(xs: list) -> bool:
    return all(isinstance(x, dict) and "id" in x for x in xs)


def resolve(state: Any, path: str) -> Any:
    """Read a value with a tiny path language: a.b[id=t_1].status"""
    cur = state
    for part in _split(path):
        if part.startswith("["):
            key, val = part[1:-1].split("=", 1)
            cur = next((x for x in cur if str(x.get(key)) == val), None)
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def _split(path: str) -> list[str]:
    parts, buf = [], ""
    for ch in path:
        if ch == "." and buf:
            parts.append(buf); buf = ""
        elif ch == "[":
            if buf:
                parts.append(buf)
            buf = "["
        elif ch == "]":
            parts.append(buf + "]"); buf = ""
        elif ch != ".":
            buf += ch
    if buf:
        parts.append(buf)
    return parts
