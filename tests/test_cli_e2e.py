from __future__ import annotations

import json
import logging
import re
import sys
import webbrowser
from pathlib import Path

import click
import pytest
import yaml
from click.testing import CliRunner

import moodle_cli.cli as cli_module
import moodle_cli.config as config_module
from moodle_cli.exceptions import AuthError, MoodleAPIError, MoodleCLIError
from moodle_cli.models import Activity, Course, Section, UserInfo
from moodle_cli.update_check import UpdateInfo

BASE_URL = "https://school.example.edu"
OVERRIDE_BASE_URL = "https://override.example.edu"
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")

USER = UserInfo(
    userid=7,
    username="alice",
    fullname="Alice Example",
    sitename="Campus",
    siteurl=BASE_URL,
    lang="en",
)
COURSES = [
    Course(id=101, shortname="MATH101", fullname="Mathematics 101", visible=True),
    Course(id=202, shortname="HIST202", fullname="History 202", visible=False),
]
SECTIONS = [
    Section(
        id=11,
        name="Introduction",
        section=1,
        activities=[
            Activity(id=21, name="Syllabus", modname="resource", visible=True),
            Activity(id=22, name="Quiz 1", modname="quiz", visible=False),
        ],
    ),
    Section(id=12, name="Week 2", section=2, visible=False, activities=[]),
]


class FakeClient:
    def __init__(self) -> None:
        self.course_ids: list[int] = []

    def get_site_info(self) -> UserInfo:
        return USER

    def get_courses(self) -> list[Course]:
        return COURSES

    def get_course_contents(self, course_id: int) -> list[Section]:
        self.course_ids.append(course_id)
        return SECTIONS


class FakeTTY:
    def isatty(self) -> bool:
        return True


class FakePipe:
    def isatty(self) -> bool:
        return False


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


def patch_runtime(
    monkeypatch: pytest.MonkeyPatch,
    *,
    client: FakeClient | None = None,
    base_url: str = BASE_URL,
    patch_config: bool = True,
) -> tuple[FakeClient, dict[str, list[tuple[str, str]] | list[str]]]:
    fake_client = client or FakeClient()
    state: dict[str, list[tuple[str, str]] | list[str]] = {
        "session_base_urls": [],
        "client_inits": [],
    }

    if patch_config:
        monkeypatch.setattr(cli_module, "load_config", lambda: {"base_url": base_url})

    def fake_get_session(seen_base_url: str) -> str:
        state["session_base_urls"].append(seen_base_url)
        return "session-cookie"

    def fake_client_factory(seen_base_url: str, session_cookie: str) -> FakeClient:
        state["client_inits"].append((seen_base_url, session_cookie))
        return fake_client

    monkeypatch.setattr(cli_module, "get_session", fake_get_session)
    monkeypatch.setattr(cli_module, "MoodleClient", fake_client_factory)
    return fake_client, state


def run_main(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], args: list[str]) -> tuple[int, str, str]:
    monkeypatch.setattr(sys, "argv", ["moodle", *args])
    with pytest.raises(SystemExit) as excinfo:
        cli_module.main()
    captured = capsys.readouterr()
    return excinfo.value.code, captured.out, captured.err


def normalize_terminal_text(text: str) -> str:
    return " ".join(ANSI_ESCAPE_RE.sub("", text).split())


@pytest.mark.parametrize("args", [["--help"], ["--version"]])
def test_global_help_and_version_do_not_load_runtime(monkeypatch: pytest.MonkeyPatch, runner: CliRunner, args: list[str]) -> None:
    monkeypatch.setattr(cli_module, "load_config", lambda: pytest.fail("load_config should not run"))
    monkeypatch.setattr(cli_module, "get_session", lambda _base_url: pytest.fail("get_session should not run"))
    monkeypatch.setattr(cli_module, "MoodleClient", lambda *_args: pytest.fail("MoodleClient should not run"))

    result = runner.invoke(cli_module.cli, args)

    assert result.exit_code == 0
    if args == ["--help"]:
        assert "Terminal-first CLI for Moodle LMS." in result.stdout
        assert "activities" in result.stdout
        assert "courses" in result.stdout
        assert "update" in result.stdout
    else:
        assert "version 0.1.1" in result.stdout


@pytest.mark.parametrize(
    ("args", "expected_level"),
    [
        (["user", "--json"], logging.WARNING),
        (["-v", "user", "--json"], logging.DEBUG),
    ],
)
def test_verbose_flag_sets_logging_level(
    monkeypatch: pytest.MonkeyPatch,
    runner: CliRunner,
    args: list[str],
    expected_level: int,
) -> None:
    _, _ = patch_runtime(monkeypatch)
    calls: list[dict] = []

    def fake_basic_config(**kwargs: object) -> None:
        calls.append(kwargs)

    monkeypatch.setattr(cli_module.logging, "basicConfig", fake_basic_config)

    result = runner.invoke(cli_module.cli, args)

    assert result.exit_code == 0
    assert calls
    assert calls[-1]["level"] == expected_level


@pytest.mark.parametrize(
    ("args", "loader", "expected", "texts", "expected_course_ids"),
    [
        (["user"], None, None, ["Alice Example", "Campus", BASE_URL, "User ID"], []),
        (["user", "--json"], json.loads, USER.to_dict(), None, []),
        (["user", "--yaml"], yaml.safe_load, USER.to_dict(), None, []),
        (["courses"], None, None, ["Enrolled Courses", "MATH101", "History 202", "Yes", "No"], []),
        (["courses", "--json"], json.loads, [course.to_dict() for course in COURSES], None, []),
        (["courses", "--yaml"], yaml.safe_load, [course.to_dict() for course in COURSES], None, []),
        (["activities", "42"], None, None, ["Course 42", "Introduction", "Syllabus", "Quiz 1", "Week 2", "No activities"], [42]),
        (["activities", "42", "--json"], json.loads, [section.to_dict() for section in SECTIONS], None, [42]),
        (["activities", "42", "--yaml"], yaml.safe_load, [section.to_dict() for section in SECTIONS], None, [42]),
        (["course", "42"], None, None, ["Course 42", "Introduction", "Syllabus", "Quiz 1", "Week 2", "No activities"], [42]),
        (["course", "42", "--json"], json.loads, [section.to_dict() for section in SECTIONS], None, [42]),
        (["course", "42", "--yaml"], yaml.safe_load, [section.to_dict() for section in SECTIONS], None, [42]),
    ],
)
def test_commands_cover_all_output_modes(
    monkeypatch: pytest.MonkeyPatch,
    runner: CliRunner,
    args: list[str],
    loader,
    expected,
    texts: list[str] | None,
    expected_course_ids: list[int],
) -> None:
    client, state = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, args)

    assert result.exit_code == 0
    assert state["session_base_urls"] == [BASE_URL]
    assert state["client_inits"] == [(BASE_URL, "session-cookie")]
    assert client.course_ids == expected_course_ids

    if loader is None:
        assert texts is not None
        for text in texts:
            assert text in result.stdout
    else:
        assert loader(result.stdout) == expected


def test_json_takes_precedence_over_yaml(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    _, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, ["user", "--json", "--yaml"])

    assert result.exit_code == 0
    assert json.loads(result.stdout) == USER.to_dict()


@pytest.mark.parametrize(
    ("args", "info", "loader", "expected", "texts"),
    [
        (
            ["update"],
            UpdateInfo(
                package_name="moodle-cli",
                current_version="0.1.1",
                latest_version="0.1.2",
                update_available=True,
                upgrade_commands=["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                pypi_url="https://pypi.org/project/moodle-cli/",
            ),
            None,
            None,
            ["Update available:", "0.1.2", "installed: 0.1.1", "uv tool upgrade moodle-cli"],
        ),
        (
            ["update", "--json"],
            UpdateInfo(
                package_name="moodle-cli",
                current_version="0.1.1",
                latest_version="0.1.2",
                update_available=True,
                upgrade_commands=["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                pypi_url="https://pypi.org/project/moodle-cli/",
            ),
            json.loads,
            {
                "package_name": "moodle-cli",
                "current_version": "0.1.1",
                "latest_version": "0.1.2",
                "update_available": True,
                "upgrade_commands": ["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                "pypi_url": "https://pypi.org/project/moodle-cli/",
            },
            None,
        ),
        (
            ["update", "--yaml"],
            UpdateInfo(
                package_name="moodle-cli",
                current_version="0.1.1",
                latest_version="0.1.2",
                update_available=True,
                upgrade_commands=["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                pypi_url="https://pypi.org/project/moodle-cli/",
            ),
            yaml.safe_load,
            {
                "package_name": "moodle-cli",
                "current_version": "0.1.1",
                "latest_version": "0.1.2",
                "update_available": True,
                "upgrade_commands": ["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                "pypi_url": "https://pypi.org/project/moodle-cli/",
            },
            None,
        ),
        (
            ["update"],
            UpdateInfo(
                package_name="moodle-cli",
                current_version="0.1.1",
                latest_version="0.1.1",
                update_available=False,
                upgrade_commands=["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                pypi_url="https://pypi.org/project/moodle-cli/",
            ),
            None,
            None,
            ["moodle-cli is up to date", "(0.1.1)"],
        ),
    ],
)
def test_update_outputs_without_loading_moodle_runtime(
    monkeypatch: pytest.MonkeyPatch,
    runner: CliRunner,
    args: list[str],
    info: UpdateInfo,
    loader,
    expected,
    texts: list[str] | None,
) -> None:
    monkeypatch.setattr(cli_module, "load_config", lambda: pytest.fail("load_config should not run"))
    monkeypatch.setattr(cli_module, "get_session", lambda _base_url: pytest.fail("get_session should not run"))
    monkeypatch.setattr(cli_module, "MoodleClient", lambda *_args: pytest.fail("MoodleClient should not run"))
    monkeypatch.setattr(cli_module, "check_for_updates", lambda: info)

    result = runner.invoke(cli_module.cli, args)

    assert result.exit_code == 0
    assert "Checking for updates..." in normalize_terminal_text(result.stderr)
    if loader is None:
        assert texts is not None
        for text in texts:
            assert text in normalize_terminal_text(result.output)
    else:
        assert loader(result.stdout) == expected


@pytest.mark.parametrize("command", ["activities", "course"])
def test_course_commands_require_course_id(monkeypatch: pytest.MonkeyPatch, runner: CliRunner, command: str) -> None:
    monkeypatch.setattr(cli_module, "load_config", lambda: {"base_url": BASE_URL})

    result = runner.invoke(cli_module.cli, [command])

    assert result.exit_code == 2
    assert "Missing argument 'COURSE_ID'" in result.output
    assert "Run 'moodle courses' to list available course IDs" in result.output
    assert f"then retry with 'moodle {command} COURSE_ID'" in result.output


@pytest.mark.parametrize("command", ["activities", "course"])
def test_course_commands_validate_course_id_type(monkeypatch: pytest.MonkeyPatch, runner: CliRunner, command: str) -> None:
    monkeypatch.setattr(cli_module, "load_config", lambda: {"base_url": BASE_URL})

    result = runner.invoke(cli_module.cli, [command, "abc"])

    assert result.exit_code == 2
    assert "is not a valid integer" in result.output


def test_unknown_command_shows_click_error(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    monkeypatch.setattr(cli_module, "load_config", lambda: {"base_url": BASE_URL})

    result = runner.invoke(cli_module.cli, ["unknown"])

    assert result.exit_code == 2
    assert "No such command 'unknown'" in result.output


@pytest.mark.parametrize(
    ("args", "expected_stderr"),
    [
        (["courses"], "Loading courses..."),
        (["activities", "42"], "Loading activities for course 42..."),
        (["course", "42"], "Loading course 42..."),
    ],
)
def test_slow_commands_print_loading_hint(
    monkeypatch: pytest.MonkeyPatch,
    runner: CliRunner,
    args: list[str],
    expected_stderr: str,
) -> None:
    _, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, args)

    assert result.exit_code == 0
    assert expected_stderr in normalize_terminal_text(result.stderr)


def test_env_base_url_overrides_config_file(monkeypatch: pytest.MonkeyPatch, runner: CliRunner, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "config.yaml").write_text("base_url: https://wrong.example.edu/path\n", encoding="utf-8")
    _, state = patch_runtime(monkeypatch, patch_config=False)

    result = runner.invoke(
        cli_module.cli,
        ["user", "--json"],
        env={"MOODLE_BASE_URL": f"{OVERRIDE_BASE_URL}/"},
    )

    assert result.exit_code == 0
    assert state["session_base_urls"] == [OVERRIDE_BASE_URL]
    assert state["client_inits"] == [(OVERRIDE_BASE_URL, "session-cookie")]


def test_first_run_prompt_retries_until_valid_root_url_then_saves_config(
    monkeypatch: pytest.MonkeyPatch,
    runner: CliRunner,
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_DIR", str(tmp_path / ".config" / "moodle-cli"))
    monkeypatch.setattr(config_module.click, "get_text_stream", lambda _name: FakeTTY())
    monkeypatch.setattr(
        config_module,
        "_probe_base_url",
        lambda base_url: (
            (False, f"{base_url} does not look like a Moodle site")
            if base_url == BASE_URL
            else (True, "")
        ),
    )
    _, _ = patch_runtime(monkeypatch, patch_config=False)

    result = runner.invoke(
        cli_module.cli,
        ["user", "--json"],
        input="example.com\nhttps://school.example.edu/path\nhttps://school.example.edu\nhttps://override.example.edu\n",
    )

    saved = tmp_path / ".config" / "moodle-cli" / "config.yaml"
    assert result.exit_code == 0
    assert "Configuration required" in result.stdout
    assert "Moodle base URL is not configured yet." in result.stdout
    assert "Required format: https://school.example.edu" in result.stdout
    assert "Moodle base URL >" in result.stdout
    assert "Invalid URL: Base URL must include the scheme" in result.stdout
    assert "Invalid URL: Base URL must be the site root" in result.stdout
    assert "Validation failed: https://school.example.edu does not look like a Moodle site" in result.stdout
    assert f"Saved base_url to {saved}" in result.stdout
    assert yaml.safe_load(saved.read_text(encoding="utf-8")) == {"base_url": OVERRIDE_BASE_URL}


def test_first_run_prompt_saves_to_existing_empty_config_file(
    monkeypatch: pytest.MonkeyPatch,
    runner: CliRunner,
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "config.yaml").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(config_module.click, "get_text_stream", lambda _name: FakeTTY())
    monkeypatch.setattr(config_module, "_probe_base_url", lambda _base_url: (True, ""))
    _, _ = patch_runtime(monkeypatch, patch_config=False)

    result = runner.invoke(
        cli_module.cli,
        ["user", "--json"],
        input="https://school.example.edu\n",
    )

    saved = tmp_path / "config.yaml"
    assert result.exit_code == 0
    assert "Moodle base URL >" in result.stdout
    assert f"Saved base_url to {saved}" in result.stdout
    assert yaml.safe_load(saved.read_text(encoding="utf-8")) == {"base_url": BASE_URL}


def test_probe_base_url_accepts_moodle_token_endpoint() -> None:
    class FakeResponse:
        def __init__(self, url: str, status_code: int, headers: dict[str, str], text: str, history: list[object]) -> None:
            self.url = url
            self.status_code = status_code
            self.headers = headers
            self.text = text
            self.history = history

    response = FakeResponse(
        "https://learning.monash.edu/login/token.php",
        200,
        {"content-type": "application/json; charset=utf-8"},
        '{"error":"A required parameter (username) was missing","errorcode":"missingparam"}',
        [],
    )

    original_get = config_module.requests.get
    config_module.requests.get = lambda *_args, **_kwargs: response
    try:
        assert config_module._probe_base_url("https://learning.monash.edu") == (True, "")
    finally:
        config_module.requests.get = original_get


def test_main_reports_missing_base_url_with_example_config_noninteractively(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_DIR", str(tmp_path / ".config" / "moodle-cli"))
    monkeypatch.setattr(config_module.click, "get_text_stream", lambda _name: FakePipe())

    exit_code, stdout, stderr = run_main(monkeypatch, capsys, ["user"])

    normalized_stderr = normalize_terminal_text(stderr)
    assert exit_code == 1
    assert stdout == ""
    assert "No base_url configured" in stderr
    assert "Add base_url to" in stderr
    assert ".config/moodle-cli" in stderr
    assert "config.yaml or set MOODLE_BASE_URL." in normalized_stderr
    assert "base_url: https://school.example.edu" in stderr
    assert "Do not include paths like /login/index.php or /my/." in stderr


def test_main_reports_missing_base_url_for_existing_empty_config_file_noninteractively(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "config.yaml").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(config_module.click, "get_text_stream", lambda _name: FakePipe())

    exit_code, stdout, stderr = run_main(monkeypatch, capsys, ["user"])

    normalized_stderr = normalize_terminal_text(stderr)
    assert exit_code == 1
    assert stdout == ""
    assert "Add base_url to" in stderr
    assert ".config/moodle-cli" not in stderr
    assert f"{tmp_path.name}/" in stderr
    assert "config.yaml or set MOODLE_BASE_URL." in normalized_stderr


def test_main_renders_auth_error_from_real_command(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(cli_module, "load_config", lambda: {"base_url": BASE_URL})
    monkeypatch.setattr(cli_module, "get_session", lambda _base_url: (_ for _ in ()).throw(AuthError("missing session")))
    opened_urls: list[str] = []

    def fake_open(url: str) -> bool:
        opened_urls.append(url)
        return True

    monkeypatch.setattr(webbrowser, "open", fake_open)

    exit_code, stdout, stderr = run_main(monkeypatch, capsys, ["user"])

    assert exit_code == 1
    assert stdout == ""
    assert "Auth error: missing session" in stderr
    assert f"Opened browser login page: {BASE_URL}/login/index.php" in stderr
    assert "Log in there, then rerun the command." in stderr
    assert opened_urls == [f"{BASE_URL}/login/index.php"]


def test_main_prints_login_url_when_browser_cannot_open(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(cli_module, "load_config", lambda: {"base_url": BASE_URL})
    monkeypatch.setattr(cli_module, "get_session", lambda _base_url: (_ for _ in ()).throw(AuthError("missing session")))
    opened_urls: list[str] = []

    def fake_open(url: str) -> bool:
        opened_urls.append(url)
        return False

    monkeypatch.setattr(webbrowser, "open", fake_open)

    exit_code, stdout, stderr = run_main(monkeypatch, capsys, ["courses"])

    assert exit_code == 1
    assert stdout == ""
    assert f"Open this login page in your browser: {BASE_URL}/login/index.php" in stderr
    assert "Log in there, then rerun the command." in stderr
    assert opened_urls == [f"{BASE_URL}/login/index.php"]


def test_main_renders_api_error_from_real_command(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class BrokenClient:
        def get_courses(self) -> list[Course]:
            raise MoodleAPIError("timeline disabled", error_code="servicenotavailable")

    monkeypatch.setattr(cli_module, "load_config", lambda: {"base_url": BASE_URL})
    monkeypatch.setattr(cli_module, "get_session", lambda _base_url: "session-cookie")
    monkeypatch.setattr(cli_module, "MoodleClient", lambda *_args: BrokenClient())

    exit_code, stdout, stderr = run_main(monkeypatch, capsys, ["courses"])

    assert exit_code == 1
    assert stdout == ""
    assert "API error: timeline disabled" in stderr
    assert "Error code: servicenotavailable" in stderr


@pytest.mark.parametrize(
    ("raised", "expected_exit_code", "expected_stderr"),
    [
        (click.exceptions.Abort(), 130, ""),
        (click.exceptions.Exit(7), 7, ""),
        (click.ClickException("bad usage"), 1, "Error: bad usage"),
        (MoodleCLIError("bad config"), 1, "Error: bad config"),
    ],
)
def test_main_wraps_click_and_cli_exceptions(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    raised: Exception,
    expected_exit_code: int,
    expected_stderr: str,
) -> None:
    def fake_cli(*_args, **_kwargs) -> None:
        raise raised

    monkeypatch.setattr(cli_module, "cli", fake_cli)

    exit_code, stdout, stderr = run_main(monkeypatch, capsys, ["user"])

    assert exit_code == expected_exit_code
    assert stdout == ""
    if expected_stderr:
        assert expected_stderr in stderr
    else:
        assert stderr == ""
