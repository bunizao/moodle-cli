from __future__ import annotations

import pytest

from moodle_cli.skill_bundle import build_install_command, install_skill


def test_build_install_command_appends_extra_args() -> None:
    assert build_install_command(["--agent", "codex"]) == [
        "npx",
        "skills",
        "add",
        "https://github.com/bunizao/moodle-cli",
        "--agent",
        "codex",
    ]


def test_build_install_command_supports_npm_exec() -> None:
    assert build_install_command(["--agent", "codex"], launcher="npm") == [
        "npm",
        "exec",
        "--yes",
        "--",
        "skills",
        "add",
        "https://github.com/bunizao/moodle-cli",
        "--agent",
        "codex",
    ]


def test_install_skill_requires_node_launcher(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("moodle_cli.skill_bundle.shutil.which", lambda name: None)

    with pytest.raises(RuntimeError, match="npx or npm is required"):
        install_skill()


def test_install_skill_runs_npx_skills_add(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class CompletedProcess:
        returncode = 0

    monkeypatch.setattr("moodle_cli.skill_bundle.shutil.which", lambda name: "/usr/bin/npx")

    def fake_run(command: list[str], check: bool = False) -> CompletedProcess:
        captured["command"] = command
        captured["check"] = check
        return CompletedProcess()

    monkeypatch.setattr("moodle_cli.skill_bundle.subprocess.run", fake_run)

    install_skill(["--agent", "codex", "--yes"])

    assert captured == {
        "command": [
            "npx",
            "skills",
            "add",
            "https://github.com/bunizao/moodle-cli",
            "--agent",
            "codex",
            "--yes",
        ],
        "check": False,
    }


def test_install_skill_falls_back_to_npm_exec(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class CompletedProcess:
        returncode = 0

    def fake_which(name: str) -> str | None:
        if name == "npx":
            return None
        if name == "npm":
            return "/usr/bin/npm"
        return None

    def fake_run(command: list[str], check: bool = False) -> CompletedProcess:
        captured["command"] = command
        captured["check"] = check
        return CompletedProcess()

    monkeypatch.setattr("moodle_cli.skill_bundle.shutil.which", fake_which)
    monkeypatch.setattr("moodle_cli.skill_bundle.subprocess.run", fake_run)

    install_skill(["--agent", "codex"])

    assert captured == {
        "command": [
            "npm",
            "exec",
            "--yes",
            "--",
            "skills",
            "add",
            "https://github.com/bunizao/moodle-cli",
            "--agent",
            "codex",
        ],
        "check": False,
    }
