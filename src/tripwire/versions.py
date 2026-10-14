"""Prompt history for simulated scenarios: scenarios/<name>/versions/<n>.json.

{n, created, note, author: "human"|"agent", sections}. Version 1 is created lazily from the
prompt as it is when history is first needed; a prompt.md edited by hand gets its own version
the next time history is read.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from tripwire.core.agent import parse_sections

_lock = threading.Lock()


def _dir(root: Path) -> Path:
    return Path(root) / "versions"


def _read(root: Path) -> list[dict]:
    d = _dir(root)
    vs = [json.loads(p.read_text()) for p in d.glob("*.json")] if d.exists() else []
    return sorted(vs, key=lambda v: v["n"])


def _prompt(root: Path) -> dict[str, str]:
    import yaml

    meta = yaml.safe_load((Path(root) / "scenario.yaml").read_text()) or {}
    return parse_sections((Path(root) / meta.get("prompt", "prompt.md")).read_text())


def _write(root: Path, n: int, sections: dict, note: str, author: str) -> dict:
    v = {"n": n, "created": time.time(), "note": note or "", "author": author, "sections": dict(sections)}
    _dir(root).mkdir(exist_ok=True)
    tmp = _dir(root) / f"{n}.tmp"
    tmp.write_text(json.dumps(v, indent=1))
    tmp.replace(_dir(root) / f"{n}.json")
    return v


def history(root: Path) -> list[dict]:
    """All versions, oldest first; makes sure the current prompt.md is the latest one."""
    with _lock:
        vs = _read(root)
        current = _prompt(root)
        if not vs:
            vs = [_write(root, 1, current, "first version", "human")]
        elif vs[-1]["sections"] != current:
            vs.append(_write(root, vs[-1]["n"] + 1, current, "prompt.md edited outside tripwire", "human"))
        return vs


def get(root: Path, n: int | None = None) -> dict | None:
    vs = history(root)
    return vs[-1] if n is None else next((v for v in vs if v["n"] == n), None)


def record(root: Path, note: str = "", author: str = "human") -> tuple[dict, bool]:
    """Call right after prompt.md was saved. -> (version, changed); no new version if the prompt is unchanged.
    Call history() before saving so the old prompt is kept as version 1."""
    with _lock:
        vs, sections = _read(root), _prompt(root)
        if vs and vs[-1]["sections"] == sections:
            return vs[-1], False
        return _write(root, (vs[-1]["n"] + 1) if vs else 1, sections, note, author), True


def number_for(root: Path, sections: dict) -> int | None:
    """Latest version with exactly these sections (None if the prompt was never saved like this)."""
    return next((v["n"] for v in reversed(history(root)) if v["sections"] == sections), None)


def meta(v: dict) -> dict:
    return {k: v[k] for k in ("n", "created", "note", "author")} | {"sections": list(v["sections"])}


def version_of(scn, sections: dict) -> int | None:
    """The version number a run of `scn` with `sections` records as config.prompt_version."""
    if scn.env_kind != "simulated" or not (Path(scn.root) / "scenario.yaml").exists():
        return None
    return number_for(scn.root, sections)
