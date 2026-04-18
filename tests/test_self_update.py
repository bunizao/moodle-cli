from __future__ import annotations

import pytest

from moodle_cli.self_update import apply_update


def test_apply_update_requires_supported_launcher(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("moodle_cli.self_update.shutil.which", lambda name: None)

    with pytest.raises(RuntimeError, match="uv or pipx is required"):
        apply_update("moodle-cli")


def test_apply_update_uses_uv_first(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class CompletedProcess:
        returncode = 0

    def fake_which(name: str) -> str | None:
        if name in {"uv", "pipx"}:
            return f"/usr/bin/{name}"
        return None

    def fake_run(command: list[str], check: bool = False) -> CompletedProcess:
        captured["command"] = command
        captured["check"] = check
        return CompletedProcess()

    monkeypatch.setattr("moodle_cli.self_update.shutil.which", fake_which)
    monkeypatch.setattr("moodle_cli.self_update.subprocess.run", fake_run)

    used = apply_update("moodle-cli")

    assert used == "uv tool upgrade moodle-cli"
    assert captured == {
        "command": ["uv", "tool", "upgrade", "moodle-cli"],
        "check": False,
    }


def test_apply_update_falls_back_to_pipx(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    class CompletedProcess:
        def __init__(self, returncode: int) -> None:
            self.returncode = returncode

    def fake_which(name: str) -> str | None:
        if name in {"uv", "pipx"}:
            return f"/usr/bin/{name}"
        return None

    def fake_run(command: list[str], check: bool = False) -> CompletedProcess:
        calls.append(command)
        if command[0] == "uv":
            return CompletedProcess(1)
        return CompletedProcess(0)

    monkeypatch.setattr("moodle_cli.self_update.shutil.which", fake_which)
    monkeypatch.setattr("moodle_cli.self_update.subprocess.run", fake_run)

    used = apply_update("moodle-cli")

    assert used == "pipx upgrade moodle-cli"
    assert calls == [
        ["uv", "tool", "upgrade", "moodle-cli"],
        ["pipx", "upgrade", "moodle-cli"],
    ]


def test_apply_update_reports_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    class CompletedProcess:
        returncode = 2

    def fake_which(name: str) -> str | None:
        if name in {"uv", "pipx"}:
            return f"/usr/bin/{name}"
        return None

    monkeypatch.setattr("moodle_cli.self_update.shutil.which", fake_which)
    monkeypatch.setattr(
        "moodle_cli.self_update.subprocess.run",
        lambda command, check=False: CompletedProcess(),
    )

    with pytest.raises(RuntimeError, match="uv tool upgrade moodle-cli exited with status 2"):
        apply_update("moodle-cli")
