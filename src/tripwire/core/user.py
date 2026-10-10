"""Simulated customer: scripted turns or an LLM playing a persona.

Research note: LLM customers are too cooperative compared with real people
(Sim2Real, CMU 2026), so personas carry an explicit style and a goal they keep
pushing for, and only know the facts we give them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from tripwire.core.backends import Backend
from tripwire.core.trace import Turn


@dataclass
class ScriptedUser:
    messages: list[str]
    _i: int = 0

    def next(self, turns: list[Turn]) -> str | None:
        if self._i >= len(self.messages):
            return None
        msg = self.messages[self._i]
        self._i += 1
        return msg


@dataclass
class PersonaUser:
    persona: dict
    model: str
    backend: Backend
    max_turns: int = 8
    cost_usd: float = field(default=0.0, init=False)
    _n: int = field(default=0, init=False)

    def next(self, turns: list[Turn]) -> str | None:
        if self._n >= self.max_turns:
            return None
        self._n += 1
        p = self.persona
        system = f"""You are role-playing a customer contacting support. Stay in character. You are not an assistant.

Who you are: {p.get('who', 'a customer')}
Your goal: {p['goal']}
How you behave: {p.get('style', 'normal, a little impatient')}
Facts you know (use only these; if asked for something not here, say you don't have it): {p.get('knows', 'nothing special')}
{p.get('secret', '')}

Write the customer's next message only, short like a real chat message.
Set done=true when your goal is met, or when the agent has clearly said no and you have pushed back at least {p.get('pushback', 2)} times, or the conversation is over."""
        transcript = "\n".join(
            f"[{'you' if t.role == 'user' else 'support'}] {t.text}" for t in turns if t.role in ("user", "agent")
        ) or "(conversation not started; write your opening message)"
        out = self.backend.complete_json(
            model=self.model, system=system, prompt=transcript,
            schema={"type": "object", "properties": {"message": {"type": "string"}, "done": {"type": "boolean"}},
                    "required": ["message", "done"]},
        )
        self.cost_usd += out.cost_usd
        if out.data.get("done") and turns:
            return None
        return out.data.get("message", "").strip() or None
