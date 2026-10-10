"""Model backends.

Two kinds of call:
- complete_json: "give me JSON matching this schema" (user simulator, judge, simulated tools, drafting).
- run_agent_turn: one turn of the agent under test with REAL tools. The model calls tools
  natively; the harness runs each one through call_tool(name, args) -> (result, blocked),
  in order, inside the trial's contextvars context.

Backends:
- ClaudeCode: `claude -p` headless. Uses your Claude subscription, no API key.
- Anthropic: the Python SDK (needs ANTHROPIC_API_KEY).

Every call is bounded twice: its own timeout, and the budget of the trial it
belongs to (see Budget). Transient failures are retried by Retrying.
"""

from __future__ import annotations

import contextvars
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


@dataclass
class Completion:
    data: dict
    cost_usd: float = 0.0
    latency_s: float = 0.0


@dataclass
class ToolCallRecord:
    name: str
    args: dict
    result: Any
    blocked: bool = False


@dataclass
class AgentTurn:
    reply: str  # "" if the model used all its tool rounds without answering
    calls: list[ToolCallRecord] = field(default_factory=list)  # in execution order
    cost_usd: float = 0.0
    latency_s: float = 0.0
    ignored: list[str] = field(default_factory=list)  # harmless built-in tool uses seen (e.g. EndConversation)


CallTool = Callable[[str, dict], "tuple[Any, bool]"]


class BackendError(RuntimeError):
    """A call failed in a way worth retrying (timeout, bad output, CLI error)."""


class ProtocolError(BackendError):
    """The model broke the protocol (a native call to a tool it doesn't have). Redo at once,
    unless the turn already ran a tool."""


class ToolsAlreadyRan(BackendError):
    """An agent turn failed after it had executed tools. Redoing the turn would run (possibly
    mutating) tools twice, so it is not retried here; the runner reruns the whole trial."""


class Refusal(BackendError):
    """The model refused. Retrying won't help."""


class TrialTimeout(BackendError):
    """The trial's time budget ran out. Not retried: the trial is over."""


class Stopped(BackendError):
    """The run was stopped by the user."""


@dataclass
class Budget:
    """Time budget for one trial, shared by every model call made inside it."""

    deadline: float | None = None  # time.monotonic() value
    stop: threading.Event | None = None
    limit_s: float | None = None
    protocol_retries: int = 0  # steps redone after a ProtocolError, for the trial record

    def remaining(self) -> float | None:
        return None if self.deadline is None else self.deadline - time.monotonic()

    def check(self) -> None:
        if self.stop is not None and self.stop.is_set():
            raise Stopped("run stopped")
        r = self.remaining()
        if r is not None and r <= 0:
            raise TrialTimeout(f"trial exceeded its {self.limit_s:.0f}s budget")

    def call_timeout(self, default: float) -> float:
        """Timeout for the next call: the call's own limit, capped by what's left of the trial."""
        self.check()
        r = self.remaining()
        return default if r is None else max(1.0, min(default, r))


_budget: contextvars.ContextVar[Budget] = contextvars.ContextVar("tripwire_budget", default=Budget())


def current_budget() -> Budget:
    return _budget.get()


@contextmanager
def budget(seconds: float | None, stop: threading.Event | None = None):
    """Run a block under a time budget (None = unbounded, still honours stop)."""
    b = Budget(None if seconds is None else time.monotonic() + seconds, stop, seconds)
    token = _budget.set(b)
    try:
        yield b
    finally:
        _budget.reset(token)


class Backend(Protocol):
    name: str

    def complete_json(self, *, model: str, system: str, prompt: str, schema: dict) -> Completion: ...

    def run_agent_turn(self, *, model: str, system: str, transcript: str, tools: list[dict],
                       call_tool: CallTool, max_rounds: int) -> AgentTurn: ...


def _recording(call_tool: CallTool, calls: list[ToolCallRecord]) -> CallTool:
    def run(name: str, args: dict):
        result, blocked = call_tool(name, args)
        calls.append(ToolCallRecord(name, args, result, bool(blocked)))
        return result, blocked
    return run


# Built-in tools Claude Code may keep even with --tools "" once MCP tools exist.
# Using one is harmless: record it in AgentTurn.ignored, don't fail the turn.
HARMLESS_BUILTINS = {"EndConversation"}


class ClaudeCode:
    """`claude -p` in an empty working dir with user settings, MCP servers and built-in tools
    off, so the model only sees our system prompt (not your CLAUDE.md, claude.ai connectors
    or Claude Code tools)."""

    name = "claude-code"

    def __init__(self, binary: str = "claude", timeout_s: int = 180, effort: str | None = None):
        self.binary = shutil.which(binary) or binary
        self.timeout_s = timeout_s
        self.effort = effort
        self._cwd = tempfile.mkdtemp(prefix="tripwire-cc-")

    def complete_json(self, *, model: str, system: str, prompt: str, schema: dict) -> Completion:
        cmd = [
            self.binary, "-p",
            "--model", model,
            "--system-prompt", system,
            "--tools", "",
            "--setting-sources", "project",
            "--strict-mcp-config",  # --setting-sources alone still loads claude.ai connectors
            "--no-session-persistence",
            "--output-format", "stream-json", "--verbose",  # stream-json shows native tool attempts
            "--json-schema", json.dumps(schema),
        ]
        if self.effort:
            cmd += ["--effort", self.effort]
        b = current_budget()
        timeout = b.call_timeout(self.timeout_s)
        stdout, stderr = _run_killable(cmd, prompt, timeout, self._cwd, b.stop)
        b.check()  # a stop or an exhausted budget wins over whatever came back
        if stdout is None:
            raise BackendError(f"claude -p timed out after {timeout:.0f}s")
        return _parse_stream(stdout, stderr)

    def run_agent_turn(self, *, model: str, system: str, transcript: str, tools: list[dict],
                       call_tool: CallTool, max_rounds: int) -> AgentTurn:
        """One `claude -p` per agent turn. Tools are served by a stdio MCP bridge (mcp_bridge.py)
        that forwards each call to a ToolServer thread here, which runs call_tool inside a copy
        of this thread's context (so the trial's budget and stop flag apply)."""
        from tripwire.core.mcp_bridge import PREFIX, ToolServer, mcp_config

        calls: list[ToolCallRecord] = []
        b = current_budget()
        timeout = b.call_timeout(self.timeout_s)
        with ToolServer(tools, _recording(call_tool, calls), contextvars.copy_context()) as srv:
            cmd = [
                self.binary, "-p",
                "--model", model,
                "--system-prompt", system,
                "--tools", "",  # no built-ins
                "--setting-sources", "project",
                "--strict-mcp-config", "--mcp-config", json.dumps(mcp_config(srv.path)),
                "--allowedTools", f"{PREFIX}*",
                "--permission-mode", "dontAsk", "--permission-prompts", "none",
                "--max-turns", str(max_rounds + 1),
                "--no-session-persistence",
                "--output-format", "stream-json", "--verbose",
            ]
            if self.effort:
                cmd += ["--effort", self.effort]
            env = {**os.environ, "ENABLE_TOOL_SEARCH": "false", "MCP_TIMEOUT": "30000",
                   "MCP_TOOL_TIMEOUT": str(int(self.timeout_s * 1000))}
            stdout, stderr = _run_killable(cmd, transcript, timeout, self._cwd, b.stop, env=env)
        b.check()
        if srv.error is not None:  # call_tool raised (budget out, stop, simulator failure)
            raise srv.error
        if stdout is None:
            raise BackendError(f"claude -p timed out after {timeout:.0f}s")
        return _parse_agent_stream(stdout, stderr, calls, PREFIX)


def _events(stdout: str) -> list[dict]:
    out = []
    for line in stdout.splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def _tool_uses(events: list[dict]) -> list[str]:
    return [blk.get("name") for e in events if e.get("type") == "assistant"
            for blk in (e.get("message") or {}).get("content") or []
            if blk.get("type") == "tool_use"]


def _parse_stream(stdout: str, stderr: str = "") -> Completion:
    events = _events(stdout)
    out = next((e for e in events if e.get("type") == "result"), None)
    if out is None:
        raise BackendError(f"claude -p gave no result: {stdout[-300:]} {stderr[-300:]}")
    if out.get("is_error") or out.get("structured_output") is None:
        raise BackendError(f"claude -p error: {out.get('result') or out.get('subtype')}")
    # Under --json-schema the model sometimes calls a tool it doesn't have, gets "No such tool
    # available", and carries on confused. The JSON may look fine but the step is tainted: redo it.
    native = [n for n in _tool_uses(events) if n != "StructuredOutput"]
    if native:
        raise ProtocolError(f"model tried to call {native} directly")
    return Completion(data=out["structured_output"], cost_usd=out.get("total_cost_usd") or 0.0,
                      latency_s=(out.get("duration_ms") or 0) / 1000)


def _parse_agent_stream(stdout: str, stderr: str, calls: list[ToolCallRecord], prefix: str) -> AgentTurn:
    events = _events(stdout)
    out = next((e for e in events if e.get("type") == "result"), None)
    if out is None:
        raise BackendError(f"claude -p gave no result: {stdout[-300:]} {stderr[-300:]}")
    names = _tool_uses(events)
    foreign = [n for n in names if not n.startswith(prefix) and n not in HARMLESS_BUILTINS]
    if foreign:
        raise ProtocolError(f"model tried to call {foreign}, which it doesn't have")
    if out.get("subtype") == "error_max_turns":
        reply = ""  # used all its tool rounds without answering
    elif out.get("is_error"):
        raise BackendError(f"claude -p error: {out.get('result') or out.get('subtype')}")
    else:
        reply = (out.get("result") or "").strip()
    return AgentTurn(reply=reply, calls=calls, cost_usd=out.get("total_cost_usd") or 0.0,
                     latency_s=(out.get("duration_ms") or 0) / 1000,
                     ignored=[n for n in names if n in HARMLESS_BUILTINS])


def _run_killable(cmd: list[str], stdin: str, timeout: float, cwd: str,
                  stop: threading.Event | None = None, env: dict | None = None) -> tuple[str | None, str]:
    """subprocess.run(timeout=) only kills the direct child, then waits for the pipes to
    close. If a grandchild holds them, that wait never ends (a trial once hung 39 min).
    Run in a new process group and kill the whole group instead. Polls `stop` once a
    second. Returns (None, stderr) on timeout or stop."""
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, cwd=cwd, env=env, start_new_session=True)
    end = time.monotonic() + timeout
    pending: str | None = stdin  # communicate() takes input only on the first call
    try:
        while True:
            try:
                return proc.communicate(pending, timeout=max(0.05, min(1.0, end - time.monotonic())))
            except subprocess.TimeoutExpired:
                pending = None
                if time.monotonic() >= end or (stop is not None and stop.is_set()):
                    break
        _kill_group(proc)
        try:
            _, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            err = ""
        return None, err or ""
    except BaseException:
        _kill_group(proc)
        raise


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()


class Anthropic:
    """Anthropic SDK: structured outputs for JSON, native tool use for the agent."""

    name = "anthropic"

    def __init__(self, client=None):
        if client is None:
            import anthropic  # optional dependency

            client = anthropic.Anthropic()
        self.client = client

    def complete_json(self, *, model: str, system: str, prompt: str, schema: dict) -> Completion:
        t0 = time.time()
        resp = self.client.messages.create(
            timeout=current_budget().call_timeout(180),
            model=model,
            max_tokens=8000,
            system=system,
            messages=[{"role": "user", "content": prompt}],
            output_config={"format": {"type": "json_schema", "schema": _strictify(schema)}},
        )
        if resp.stop_reason == "refusal":
            raise Refusal("model refused")
        text = "".join(b.text for b in resp.content if b.type == "text")
        return Completion(data=json.loads(text), latency_s=time.time() - t0)

    def run_agent_turn(self, *, model: str, system: str, transcript: str, tools: list[dict],
                       call_tool: CallTool, max_rounds: int) -> AgentTurn:
        """Native tool-use loop: up to max_rounds rounds of tool calls, then the reply."""
        t0 = time.time()
        calls: list[ToolCallRecord] = []
        run = _recording(call_tool, calls)
        specs = [{"name": t["name"], "description": t.get("description", ""), "input_schema": t["input_schema"]}
                 for t in tools]
        messages: list[dict] = [{"role": "user", "content": transcript}]
        for rounds in range(max_rounds + 1):
            resp = self.client.messages.create(
                timeout=current_budget().call_timeout(180), model=model, max_tokens=8000,
                system=system, messages=messages, tools=specs,
            )
            if resp.stop_reason == "refusal":
                raise Refusal("model refused")
            uses = [blk for blk in resp.content if blk.type == "tool_use"]
            if not uses:
                reply = "".join(blk.text for blk in resp.content if blk.type == "text").strip()
                return AgentTurn(reply, calls, latency_s=time.time() - t0)
            if rounds == max_rounds:
                break
            results = []
            for u in uses:
                result, blocked = run(u.name, dict(u.input or {}))
                results.append({"type": "tool_result", "tool_use_id": u.id, "is_error": bool(blocked),
                                "content": json.dumps(result, default=str)})
            messages += [{"role": "assistant", "content": resp.content}, {"role": "user", "content": results}]
        return AgentTurn("", calls, latency_s=time.time() - t0)


def _strictify(schema: dict) -> dict:
    """Structured outputs want additionalProperties: false on every object."""
    s = dict(schema)
    if s.get("type") == "object":
        s.setdefault("additionalProperties", False)
        s["properties"] = {k: _strictify(v) for k, v in s.get("properties", {}).items()}
    if s.get("type") == "array" and "items" in s:
        s["items"] = _strictify(s["items"])
    return s


class Retrying:
    """Retry transient failures with exponential backoff, inside the trial budget."""

    def __init__(self, inner: Backend, retries: int = 2, backoff_s: float = 2.0, protocol_retries: int = 5):
        self.inner, self.retries, self.backoff_s = inner, retries, backoff_s
        self.protocol_retries = protocol_retries  # separate: frequent, instant and cheap to redo
        self.name = inner.name
        self.retried = 0  # total retries, for reporting

    def complete_json(self, **kw) -> Completion:
        return self._retry(lambda: self.inner.complete_json(**kw))

    def run_agent_turn(self, *, call_tool: CallTool, **kw) -> AgentTurn:
        """Same policy as complete_json, except a turn that already ran a tool is never redone
        (mutating tools would run twice): its failure becomes ToolsAlreadyRan, and the runner
        reruns the whole trial on a fresh environment instead."""
        ran = [0]

        def counted(name: str, args: dict):
            ran[0] += 1
            return call_tool(name, args)

        def once() -> AgentTurn:
            ran[0] = 0
            try:
                return self.inner.run_agent_turn(call_tool=counted, **kw)
            except (Refusal, TrialTimeout, Stopped):
                raise
            except Exception as e:
                if ran[0] and _transient(e):
                    raise ToolsAlreadyRan(f"{type(e).__name__} after {ran[0]} tool call(s): {e}") from e
                raise

        return self._retry(once)

    def _retry(self, fn):
        attempt = redo = 0
        while True:
            try:
                return fn()
            except (Refusal, TrialTimeout, Stopped, ToolsAlreadyRan):
                raise
            except ProtocolError:
                if redo >= self.protocol_retries:
                    raise
                redo += 1
                current_budget().protocol_retries += 1
            except Exception as e:
                if not _transient(e) or attempt >= self.retries:
                    raise
                attempt += 1
                self.retried += 1
                b = current_budget()
                wait = self.backoff_s * 2 ** (attempt - 1)
                r = b.remaining()
                if r is not None and r <= wait:
                    raise
                if b.stop is not None and b.stop.wait(wait):
                    raise Stopped("run stopped") from e
                if b.stop is None:
                    time.sleep(wait)


def _transient(e: Exception) -> bool:
    if isinstance(e, BackendError):
        return True
    try:  # SDK network / overload / rate-limit errors
        import anthropic
        return isinstance(e, (anthropic.APIConnectionError, anthropic.RateLimitError, anthropic.InternalServerError))
    except ImportError:
        return False


def get_backend(name: str | None = None, retries: int = 2) -> Backend:
    name = name or os.environ.get("TRIPWIRE_BACKEND") or ("anthropic" if os.environ.get("ANTHROPIC_API_KEY") else "claude-code")
    if name == "claude-code":
        inner: Backend = ClaudeCode()
    elif name == "anthropic":
        inner = Anthropic()
    else:
        raise ValueError(f"unknown backend {name}")
    return Retrying(inner, retries) if retries else inner
