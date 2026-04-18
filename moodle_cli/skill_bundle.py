"""Skill metadata and npx skills integration helpers."""

from __future__ import annotations

import shutil
import subprocess
from typing import Iterable

SKILL_NAME = "moodle-cli"
SKILL_DESCRIPTION = (
    "Inspect Moodle data from the terminal with the `moodle` CLI. "
    "Use when an agent needs to list courses, deadlines, grades, alerts, course activities, "
    "or forum discussions. Prefer JSON output for agent workflows."
)
SKILL_SOURCE = "https://github.com/bunizao/moodle-cli"
SKILLS_SPEC_URL = "https://github.com/vercel-labs/skills"


def format_skill_summary() -> str:
    """Return the skill summary shown by `moodle skills`."""
    return "\n".join(
        [
            f"Name: {SKILL_NAME}",
            f"Description: {SKILL_DESCRIPTION}",
            f"Source: {SKILL_SOURCE}",
            f"Spec: {SKILLS_SPEC_URL}",
            f"Install: npx skills add {SKILL_SOURCE}",
            "CLI alias: moodle skills add (falls back to npm exec)",
        ]
    )


def build_install_command(extra_args: Iterable[str] = (), launcher: str = "npx") -> list[str]:
    """Build the delegated skills install command."""
    command_args = list(extra_args)
    if launcher == "npx":
        return ["npx", "skills", "add", SKILL_SOURCE, *command_args]
    if launcher == "npm":
        return ["npm", "exec", "--yes", "--", "skills", "add", SKILL_SOURCE, *command_args]
    raise ValueError(f"Unsupported launcher: {launcher}")


def install_skill(extra_args: Iterable[str] = ()) -> None:
    """Install the skill by delegating to the shared skills CLI."""
    if shutil.which("npx") is not None:
        command = build_install_command(extra_args, launcher="npx")
    elif shutil.which("npm") is not None:
        command = build_install_command(extra_args, launcher="npm")
    else:
        raise RuntimeError(
            "npx or npm is required to install agent skills. "
            f"Install Node.js, then run `npx skills add {SKILL_SOURCE}`."
        )

    try:
        completed = subprocess.run(command, check=False)
    except OSError as exc:
        raise RuntimeError(f"Failed to launch `{' '.join(command)}`: {exc}") from exc

    if completed.returncode != 0:
        raise RuntimeError(f"`{' '.join(command)}` exited with status {completed.returncode}.")
