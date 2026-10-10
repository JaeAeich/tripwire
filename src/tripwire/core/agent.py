"""The agent under test.

PromptAgent is white-box: its system prompt is an ordered set of named
sections, which is what attribution removes and the evolver edits.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from tripwire.core.backends import Backend
from tripwire.core.env import Environment
from tripwire.core.trace import ToolCall, Turn

MAX_TOOL_ROUNDS = 8


def parse_sections(markdown: str) -> dict[str, str]:
    """Split a prompt on '## Heading' lines. Text before the first heading is 'preamble'."""
    sections: dict[str, str] = {}
    name, buf = "preamble", []
    for line in markdown.splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            if "".join(buf).strip():
                sections[name] = "\n".join(buf).strip()
            name, buf = m.group(1), []
        else:
            buf.append(line)
    if "".join(buf).strip():
        sections[name] = "\n".join(buf).strip()
    return sections


def render_sections(sections: dict[str, str]) -> str:
    return "\n\n".join(text if name == "preamble" else f"## {name}\n{text}" for name, text in sections.items())


@dataclass
class PromptAgent:
    sections: dict[str, str]
    model: str
    backend: Backend
    cost_usd: float = field(default=0.0, init=False)

    @property
    def system(self) -> str:
        return render_sections(self.sections)

    def respond(self, env: Environment, turns: list[Turn], clock, on_turn=None) -> list[Turn]:
        """Act on the latest user message: zero or more native tool calls, then one reply.
        on_turn(turn) is called as each turn happens (live progress); tool turns are emitted
        from the backend's tool handler thread while the model is still working."""
        new: list[Turn] = []
        emit = on_turn or (lambda _t: None)

        def call_tool(name: str, args: dict):
            result, blocked = env.call(name, args)
            new.append(Turn("tool", tool_call=ToolCall(name, args, result, bool(blocked)), t=clock()))
            emit(new[-1])
            return result, blocked

        out = self.backend.run_agent_turn(model=self.model, system=self.system, transcript=render_transcript(turns),
                                          tools=env.tool_specs(), call_tool=call_tool, max_rounds=MAX_TOOL_ROUNDS)
        self.cost_usd += out.cost_usd
        new.append(Turn("agent", text=out.reply, t=clock()))
        emit(new[-1])
        return new


# Bump when how the agent is driven changes: results across versions are not comparable.
# v2 (2026-10-15): tools as a JSON-in-text protocol; the model kept calling them natively anyway.
# v3 (2026-10-16): real (native) tools; history rendered as a plain-text transcript.
PROTOCOL_VERSION = 3


def render_transcript(turns: list[Turn]) -> str:
    """The conversation so far, as plain text. Past tool use is described in words, not as
    call syntax, so the model uses its real tools instead of imitating the transcript."""
    lines = ["Here is your conversation with the customer so far.", ""]
    for turn in turns:
        if turn.role == "user":
            lines.append(f"Customer: {turn.text}")
        elif turn.role == "agent":
            lines.append(f"You: {turn.text}")
        else:
            c = turn.tool_call
            args = ", ".join(f"{k} = {json.dumps(v)}" for k, v in c.args.items()) or "no input"
            status = "was refused" if c.blocked else "returned"
            lines.append(f"(Earlier, you used the {c.name} tool with {args}. It {status}: {json.dumps(c.result, default=str)})")
    lines += ["", "Now write your next message to the customer. Use your tools first if you need to."]
    return "\n".join(lines)
