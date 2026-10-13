"""Draft a test scenario from a system prompt, so users don't write Python.

  draft = draft_scenario(open("prompt.md").read(), tools_text="...")
  path = write_scenario(draft, "scenarios")
"""

from tripwire.draft.build import DRAFT_MODEL, draft_scenario, parse_tools_json, split_by_lines, split_paragraphs
from tripwire.draft.io import ScenarioExists, scenario_to_draft, write_scenario
from tripwire.draft.validate import DraftError, slugify, validate_draft

__all__ = ["DRAFT_MODEL", "DraftError", "ScenarioExists", "draft_scenario", "parse_tools_json", "scenario_to_draft",
           "slugify", "split_by_lines", "split_paragraphs", "validate_draft", "write_scenario"]
