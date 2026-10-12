"""Real tools for the agent under `claude -p`, via a tiny stdio MCP server.

claude -p launches this file as an MCP server (`python -I mcp_bridge.py <socket>`). It speaks
just enough MCP (newline-delimited JSON-RPC 2.0 on stdio: initialize, ping, tools/list,
tools/call) and forwards tools/list and tools/call over a unix socket to a ToolServer thread
in the harness, which runs the scenario's tool inside the trial's contextvars context.

Stdlib only, no tripwire imports: it runs in a fresh interpreter with -I.

Socket protocol: one connection per request, one JSON line each way.
  {"op": "list"}                        -> {"tools": [{name, description, input_schema}]}
  {"op": "call", "name", "args"}        -> {"result": <json>, "blocked": bool}
"""

from __future__ import annotations

import contextvars
import json
import os
import socket
import sys
import tempfile
import threading
from typing import Any, Callable

SERVER_NAME = "tw"  # tools show up in claude as mcp__tw__<name>
PREFIX = f"mcp__{SERVER_NAME}__"


# ---------------------------------------------------------------- harness side

class ToolServer:
    """Unix socket server for one agent turn. Calls run one at a time, in arrival order,
    inside `ctx` (the trial's context, so budgets and stop flags apply). An exception from
    call_tool is kept in self.error (the caller re-raises it) and reported to the model as an
    error result."""

    def __init__(self, tools: list[dict], call_tool: Callable[[str, dict], tuple[Any, bool]],
                 ctx: contextvars.Context | None = None):
        self.tools, self.call_tool = tools, call_tool
        self.ctx = ctx or contextvars.copy_context()
        self.error: BaseException | None = None
        self._dir = tempfile.mkdtemp(prefix="tw-")
        self.path = os.path.join(self._dir, "s")
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.bind(self.path)
        self._sock.listen(8)
        self._sock.settimeout(0.2)
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def __enter__(self) -> "ToolServer":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._done.set()
        self._thread.join(timeout=5)
        self._sock.close()
        for p in (self.path, self._dir):
            try:
                os.unlink(p) if p == self.path else os.rmdir(p)
            except OSError:
                pass

    def _loop(self) -> None:
        while not self._done.is_set():
            try:
                conn, _ = self._sock.accept()
            except (socket.timeout, OSError):
                continue
            with conn:
                try:
                    conn.settimeout(None)
                    req = json.loads(_readline(conn))
                    conn.sendall((json.dumps(self._handle(req), default=str) + "\n").encode())
                except Exception:  # bridge went away mid-call; nothing to answer
                    pass

    def _handle(self, req: dict) -> dict:
        if req.get("op") == "list":
            return {"tools": self.tools}
        if self.error is not None:
            return {"result": {"error": "tool backend unavailable"}, "blocked": True}
        try:
            result, blocked = self.ctx.run(self.call_tool, req["name"], req.get("args") or {})
            return {"result": result, "blocked": bool(blocked)}
        except BaseException as e:  # noqa: BLE001 - re-raised by the caller after claude exits
            self.error = e
            return {"result": {"error": "tool backend unavailable"}, "blocked": True}


def mcp_config(socket_path: str) -> dict:
    return {"mcpServers": {SERVER_NAME: {
        "type": "stdio", "command": sys.executable, "args": ["-I", os.path.abspath(__file__), socket_path],
        "alwaysLoad": True,
    }}}


# ----------------------------------------------------------------- bridge side

def _readline(conn: socket.socket) -> str:
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
    return buf.decode()


def _ask(path: str, req: dict) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(path)
        s.sendall((json.dumps(req) + "\n").encode())
        return json.loads(_readline(s))


def _respond(msg_id, result=None, error=None) -> None:
    out = {"jsonrpc": "2.0", "id": msg_id}
    out.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


def serve(path: str) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method, msg_id = msg.get("method"), msg.get("id")
        if msg_id is None:  # notification (initialized, cancelled, ...)
            continue
        params = msg.get("params") or {}
        try:
            if method == "initialize":
                _respond(msg_id, {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                                  "capabilities": {"tools": {"listChanged": False}},
                                  "serverInfo": {"name": "tripwire", "version": "1"}})
            elif method == "ping":
                _respond(msg_id, {})
            elif method == "tools/list":
                tools = _ask(path, {"op": "list"})["tools"]
                _respond(msg_id, {"tools": [{"name": t["name"], "description": t.get("description", ""),
                                             "inputSchema": t.get("input_schema") or {"type": "object"}}
                                            for t in tools]})
            elif method == "tools/call":
                r = _ask(path, {"op": "call", "name": params.get("name"), "args": params.get("arguments") or {}})
                _respond(msg_id, {"content": [{"type": "text", "text": json.dumps(r["result"], default=str)}],
                                  "isError": bool(r["blocked"])})
            elif method in ("resources/list", "prompts/list"):
                _respond(msg_id, {method.split("/")[0]: []})
            else:
                _respond(msg_id, error={"code": -32601, "message": f"method not found: {method}"})
        except Exception as e:  # harness unreachable: tell the client instead of dying
            _respond(msg_id, error={"code": -32603, "message": f"bridge error: {e}"})


if __name__ == "__main__":
    serve(sys.argv[1])
