"""Helpers for upgrading the installed CLI package."""

from __future__ import annotations

import shutil
import subprocess


def _available_upgrade_commands(package_name: str) -> list[list[str]]:
    """Return upgrade commands for installed launchers in preferred order."""
    commands: list[list[str]] = []
    if shutil.which("uv") is not None:
        commands.append(["uv", "tool", "upgrade", package_name])
    if shutil.which("pipx") is not None:
        commands.append(["pipx", "upgrade", package_name])
    return commands


def apply_update(package_name: str) -> str:
    """Run the first working package-manager upgrade command."""
    commands = _available_upgrade_commands(package_name)
    if not commands:
        raise RuntimeError(
            "uv or pipx is required to update moodle-cli. "
            f"Install one of them, then run `uv tool upgrade {package_name}` "
            f"or `pipx upgrade {package_name}`."
        )

    failures: list[str] = []
    for command in commands:
        try:
            result = subprocess.run(command, check=False)
        except OSError as exc:
            failures.append(f"{' '.join(command)} failed to start: {exc}")
            continue

        if result.returncode == 0:
            return " ".join(command)
        failures.append(f"{' '.join(command)} exited with status {result.returncode}")

    raise RuntimeError("; ".join(failures))
