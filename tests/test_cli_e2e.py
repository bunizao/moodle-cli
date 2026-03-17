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
from moodle_cli import __version__
import moodle_cli.models as models_module
import moodle_cli.output as output_module
import moodle_cli.scraper as scraper_module
from moodle_cli.exceptions import AuthError, MoodleAPIError, MoodleCLIError, MoodleRequestError
from moodle_cli.models import (
    Activity,
    AlertNotification,
    AlertSummary,
    Course,
    CourseGrades,
    ForumActivityRef,
    ForumDiscussion,
    ForumDiscussionRef,
    ForumPost,
    ForumPostAuthor,
    ForumSearchHit,
    GradeItem,
    Overview,
    Section,
    TodoItem,
    UserInfo,
)
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
            Activity(id=501, name="General Discussion", modname="forum", visible=True, url=f"{BASE_URL}/mod/forum/view.php?id=501"),
        ],
    ),
    Section(id=12, name="Week 2", section=2, visible=False, activities=[]),
]
FORUM_REFS = [
    ForumActivityRef(id=501, name="General Discussion", course_id=101, course_name="Mathematics 101", url=f"{BASE_URL}/mod/forum/view.php?id=501"),
    ForumActivityRef(id=502, name="Essay Clinic", course_id=202, course_name="History 202", url=f"{BASE_URL}/mod/forum/view.php?id=502"),
]
FORUM_DISCUSSION_REFS = {
    501: [
        ForumDiscussionRef(id=9001, subject="Exam deadline questions", url=f"{BASE_URL}/mod/forum/discuss.php?d=9001"),
        ForumDiscussionRef(id=9002, subject="Lecture recap", url=f"{BASE_URL}/mod/forum/discuss.php?d=9002"),
    ],
}
FORUM_DISCUSSIONS = {
    9001: ForumDiscussion(
        id=9001,
        subject="Exam deadline questions",
        course_id=101,
        forum_id=501,
        url=f"{BASE_URL}/mod/forum/discuss.php?d=9001",
        posts=[
            ForumPost(
                id=9101,
                discussion_id=9001,
                subject="Exam deadline questions",
                message_text="Can we have an extension for the exam deadline?",
                author=ForumPostAuthor(id=12, fullname="Alice Example"),
                time_created=1762000000,
                unread=True,
                url=f"{BASE_URL}/mod/forum/discuss.php?d=9001#p9101",
            ),
            ForumPost(
                id=9102,
                discussion_id=9001,
                subject="Re: Exam deadline questions",
                message_text="The deadline stays the same.",
                author=ForumPostAuthor(id=13, fullname="Tutor Example"),
                time_created=1762000300,
                unread=False,
                url=f"{BASE_URL}/mod/forum/discuss.php?d=9001#p9102",
            ),
        ],
    ),
    9002: ForumDiscussion(
        id=9002,
        subject="Lecture recap",
        course_id=101,
        forum_id=501,
        url=f"{BASE_URL}/mod/forum/discuss.php?d=9002",
        posts=[
            ForumPost(
                id=9201,
                discussion_id=9002,
                subject="Lecture recap",
                message_text="Deadline summary from the last lecture.",
                author=ForumPostAuthor(id=14, fullname="Bob Example"),
                time_created=1762000900,
                unread=True,
                url=f"{BASE_URL}/mod/forum/discuss.php?d=9002#p9201",
            )
        ],
    ),
}
FORUM_SEARCH_HITS = [
    ForumSearchHit(
        course_id=101,
        course_name="Mathematics 101",
        forum_id=501,
        forum_name="General Discussion",
        discussion_id=9002,
        discussion_subject="Lecture recap",
        post_id=9201,
        author_name="Bob Example",
        matched_in="post_body",
        snippet="Deadline summary from the last lecture.",
        unread=True,
        time_created=1762000900,
        url=f"{BASE_URL}/mod/forum/discuss.php?d=9002#p9201",
    ),
    ForumSearchHit(
        course_id=101,
        course_name="Mathematics 101",
        forum_id=501,
        forum_name="General Discussion",
        discussion_id=9001,
        discussion_subject="Exam deadline questions",
        post_id=9101,
        author_name="Alice Example",
        matched_in="post_body",
        snippet="Can we have an extension for the exam deadline?",
        unread=True,
        time_created=1762000000,
        url=f"{BASE_URL}/mod/forum/discuss.php?d=9001#p9101",
    ),
]
TODO_ITEMS = [
    TodoItem(
        id=301,
        name="Quiz 1 is due",
        activity_name="Quiz 1",
        modname="quiz",
        course_id=101,
        course_name="Mathematics 101",
        due_at=1760000000,
        actionable=True,
        action_name="Attempt quiz",
        action_url="https://school.example.edu/mod/quiz/view.php?id=301",
        url="https://school.example.edu/mod/quiz/view.php?id=301",
        event_type="due",
        course_progress=42,
    ),
    TodoItem(
        id=302,
        name="Essay is due",
        activity_name="Essay",
        modname="assign",
        course_id=202,
        course_name="History 202",
        due_at=1760500000,
        actionable=True,
        action_name="Add submission",
        action_url="https://school.example.edu/mod/assign/view.php?id=302&action=editsubmission",
        url="https://school.example.edu/mod/assign/view.php?id=302",
        event_type="due",
        course_progress=10,
    ),
]
GRADES = CourseGrades(
    course_id=101,
    course_name="Mathematics 101",
    learner_name="Alice Example",
    total_grade="73.00",
    total_range="0-100",
    total_percentage="73.00 %",
    items=[
        GradeItem(
            name="Quiz 1",
            item_type="Quiz",
            grade="8.00",
            range="0-10",
            percentage="80.00 %",
            weight="100.00 %",
            contribution="20.00 %",
            feedback="",
            url="https://school.example.edu/mod/quiz/view.php?id=21",
            status="Pass",
        ),
        GradeItem(
            name="Essay",
            item_type="Assignment",
            grade="65.00",
            range="0-100",
            percentage="65.00 %",
            weight="100.00 %",
            contribution="53.00 %",
            feedback="Strong structure.",
            url="https://school.example.edu/mod/assign/view.php?id=22",
            status="",
        ),
    ],
)
ALERTS = AlertSummary(
    notifications=[
        AlertNotification(
            id=401,
            subject="Overdue: Assignment 1",
            short_subject="Overdue: Assignment 1",
            event_type="assign_overdue",
            component="mod_assign",
            created_at=1761000000,
            created_pretty="2 hours ago",
            read=False,
            context_url="https://school.example.edu/mod/assign/view.php?id=401",
            context_name="Assignment 1",
        ),
        AlertNotification(
            id=402,
            subject="Quiz closes soon",
            short_subject="Quiz closes soon",
            event_type="quiz_due",
            component="mod_quiz",
            created_at=1761000500,
            created_pretty="1 hour ago",
            read=True,
            context_url="https://school.example.edu/mod/quiz/view.php?id=402",
            context_name="Quiz 2",
        ),
    ],
    notification_count=2,
    unread_notification_count=1,
    starred_message_count=1,
    direct_message_count=3,
    group_message_count=1,
    self_message_count=0,
    unread_starred_message_count=0,
    unread_direct_message_count=2,
    unread_group_message_count=1,
    unread_self_message_count=0,
)
OVERVIEW = Overview(
    user=USER,
    courses=COURSES,
    todo=TODO_ITEMS,
    alerts=ALERTS,
    errors=[],
)


class FakeClient:
    def __init__(self) -> None:
        self.course_ids: list[int] = []
        self.todo_calls: list[tuple[int, int | None]] = []
        self.grade_course_ids: list[int] = []
        self.alert_limits: list[int] = []
        self.overview_calls: list[tuple[int, int | None, int]] = []
        self.forum_ref_ids: list[int] = []
        self.forum_discussion_ids: list[int] = []
        self.forum_search_calls: list[tuple[str, int, int | None, int | None, bool, bool, str, int | None, int | None]] = []

    def get_site_info(self) -> UserInfo:
        return USER

    def get_courses(self) -> list[Course]:
        return COURSES

    def get_course_contents(self, course_id: int) -> list[Section]:
        self.course_ids.append(course_id)
        return SECTIONS

    def get_todo(self, limit: int = 20, days: int | None = None) -> list[TodoItem]:
        self.todo_calls.append((limit, days))
        return TODO_ITEMS

    def get_course_grades(self, course_id: int) -> CourseGrades:
        self.grade_course_ids.append(course_id)
        return GRADES

    def get_alerts(self, limit: int = 20) -> AlertSummary:
        self.alert_limits.append(limit)
        return ALERTS

    def get_overview(self, todo_limit: int = 5, todo_days: int | None = None, alerts_limit: int = 5) -> Overview:
        self.overview_calls.append((todo_limit, todo_days, alerts_limit))
        return OVERVIEW

    def get_forums(self, course_id: int | None = None) -> list[ForumActivityRef]:
        if course_id is None:
            return FORUM_REFS
        return [ref for ref in FORUM_REFS if ref.course_id == course_id]

    def get_forum_discussion_refs(self, forum_cmid: int) -> list[ForumDiscussionRef]:
        self.forum_ref_ids.append(forum_cmid)
        return FORUM_DISCUSSION_REFS.get(forum_cmid, [])

    def get_forum_discussion(self, discussion_id: int) -> ForumDiscussion:
        self.forum_discussion_ids.append(discussion_id)
        return FORUM_DISCUSSIONS[discussion_id]

    def get_forum_view_cmid(self, discussion_id: int) -> int | None:
        return 501 if discussion_id in FORUM_DISCUSSIONS else None

    def search_forum_content(
        self,
        query: str,
        limit: int = 20,
        course_id: int | None = None,
        forum_cmid: int | None = None,
        include_post_text: bool = True,
        unread_only: bool = False,
        sort_by: str = "relevance",
        max_forums: int | None = None,
        max_discussions_per_forum: int | None = None,
    ) -> list[ForumSearchHit]:
        self.forum_search_calls.append(
            (
                query,
                limit,
                course_id,
                forum_cmid,
                include_post_text,
                unread_only,
                sort_by,
                max_forums,
                max_discussions_per_forum,
            )
        )
        return FORUM_SEARCH_HITS[:limit]


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


def expected_json(data):
    return output_module.optimize_json_data(data)


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
        assert "alerts" in result.stdout
        assert "courses" in result.stdout
        assert "grades" in result.stdout
        assert "overview" in result.stdout
        assert "todo" in result.stdout
        assert "update" in result.stdout
    else:
        assert f"version {__version__}" in result.stdout


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
    (
        "args",
        "loader",
        "expected",
        "texts",
        "expected_course_ids",
        "expected_todo_calls",
        "expected_grade_course_ids",
        "expected_alert_limits",
        "expected_overview_calls",
    ),
    [
        (["user"], None, None, ["Alice Example", "Campus", BASE_URL, "User ID"], [], [], [], [], []),
        (["user", "--json"], json.loads, expected_json(USER.to_dict()), None, [], [], [], [], []),
        (["user", "--yaml"], yaml.safe_load, USER.to_dict(), None, [], [], [], [], []),
        (["courses"], None, None, ["Enrolled Courses", "MATH101", "History 202", "Yes", "No"], [], [], [], [], []),
        (["courses", "--json"], json.loads, expected_json([course.to_dict() for course in COURSES]), None, [], [], [], [], []),
        (["courses", "--yaml"], yaml.safe_load, [course.to_dict() for course in COURSES], None, [], [], [], [], []),
        (["alerts"], None, None, ["Alerts", "Unread Notifications", "Overdue: Assignment 1", "Direct Messages", "Notifications"], [], [], [], [20], []),
        (["alerts", "--limit", "5", "--json"], json.loads, expected_json(ALERTS.to_dict()), None, [], [], [], [5], []),
        (["alerts", "--yaml"], yaml.safe_load, ALERTS.to_dict(), None, [], [], [], [20], []),
        (["todo"], None, None, ["Todo", "Mathematics 101", "Quiz 1", "Attempt quiz", "History 202", "Essay"], [], [(20, None)], [], [], []),
        (["todo", "--days", "7", "--limit", "5", "--json"], json.loads, expected_json([item.to_dict() for item in TODO_ITEMS]), None, [], [(5, 7)], [], [], []),
        (["todo", "--yaml"], yaml.safe_load, [item.to_dict() for item in TODO_ITEMS], None, [], [(20, None)], [], [], []),
        (["overview"], None, None, ["Overview", "Alice Example", "Courses", "Todo", "Alerts"], [], [], [], [], [(5, None, 5)]),
        (["overview", "--todo-limit", "3", "--todo-days", "7", "--alerts-limit", "2", "--json"], json.loads, expected_json(OVERVIEW.to_dict()), None, [], [], [], [], [(3, 7, 2)]),
        (["overview", "--yaml"], yaml.safe_load, OVERVIEW.to_dict(), None, [], [], [], [], [(5, None, 5)]),
        (["grades", "101"], None, None, ["Grades: Mathematics 101", "Alice Example", "Course Total", "73.00", "Quiz 1", "Essay", "Pass"], [], [], [101], [], []),
        (["grades", "101", "--json"], json.loads, expected_json(GRADES.to_dict()), None, [], [], [101], [], []),
        (["grades", "101", "--yaml"], yaml.safe_load, GRADES.to_dict(), None, [], [], [101], [], []),
        (["activities", "42"], None, None, ["Course 42", "Introduction", "Syllabus", "Quiz 1", "Week 2", "No activities"], [42], [], [], [], []),
        (["activities", "42", "--json"], json.loads, expected_json([section.to_dict() for section in SECTIONS]), None, [42], [], [], [], []),
        (["activities", "42", "--yaml"], yaml.safe_load, [section.to_dict() for section in SECTIONS], None, [42], [], [], [], []),
        (["course", "42"], None, None, ["Course 42", "Introduction", "Syllabus", "Quiz 1", "Week 2", "No activities"], [42], [], [], [], []),
        (["course", "42", "--json"], json.loads, expected_json([section.to_dict() for section in SECTIONS]), None, [42], [], [], [], []),
        (["course", "42", "--yaml"], yaml.safe_load, [section.to_dict() for section in SECTIONS], None, [42], [], [], [], []),
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
    expected_todo_calls: list[tuple[int, int | None]],
    expected_grade_course_ids: list[int],
    expected_alert_limits: list[int],
    expected_overview_calls: list[tuple[int, int | None, int]],
) -> None:
    client, state = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, args)

    assert result.exit_code == 0
    assert state["session_base_urls"] == [BASE_URL]
    assert state["client_inits"] == [(BASE_URL, "session-cookie")]
    assert client.course_ids == expected_course_ids
    assert client.todo_calls == expected_todo_calls
    assert client.grade_course_ids == expected_grade_course_ids
    assert client.alert_limits == expected_alert_limits
    assert client.overview_calls == expected_overview_calls

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
    assert json.loads(result.stdout) == expected_json(USER.to_dict())


def test_forum_forums_supports_course_name_filter_and_json(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    client, state = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, ["forum", "forums", "--course", "math", "--json"])

    assert result.exit_code == 0
    assert state["session_base_urls"] == [BASE_URL]
    assert client.forum_search_calls == []
    assert json.loads(result.stdout) == expected_json([FORUM_REFS[0].to_dict()])


def test_forum_discussions_supports_title_filter(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    client, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, ["forum", "discussions", "501", "--query", "exam", "--json"])

    assert result.exit_code == 0
    assert client.forum_ref_ids == [501]
    assert json.loads(result.stdout) == expected_json([FORUM_DISCUSSION_REFS[501][0].to_dict()])


def test_forum_search_passes_shortest_path_filters_to_client(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    client, _ = patch_runtime(monkeypatch)

    result = runner.invoke(
        cli_module.cli,
        ["forum", "search", "deadline", "--course", "mathematics", "--forum", "501", "--unread-only", "--recent", "--json"],
    )

    assert result.exit_code == 0
    assert client.forum_search_calls == [("deadline", 20, 101, 501, True, True, "recent", None, None)]
    assert json.loads(result.stdout) == expected_json([hit.to_dict() for hit in FORUM_SEARCH_HITS])


def test_forum_find_returns_single_best_match(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    client, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, ["forum", "find", "deadline", "--course", "mathematics", "--json"])

    assert result.exit_code == 0
    assert client.forum_search_calls == [("deadline", 1, 101, None, True, False, "recent", None, None)]
    assert json.loads(result.stdout) == expected_json(FORUM_SEARCH_HITS[0].to_dict())


def test_forum_find_body_resolves_directly_to_target_post(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    client, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, ["forum", "find", "deadline", "--body", "--json"])

    assert result.exit_code == 0
    assert client.forum_search_calls == [("deadline", 1, None, None, True, False, "recent", None, None)]
    assert client.forum_discussion_ids == [9002]
    filtered = FORUM_DISCUSSIONS[9002]
    expected = ForumDiscussion(
        id=filtered.id,
        subject=filtered.subject,
        course_id=filtered.course_id,
        forum_id=filtered.forum_id,
        url=filtered.url,
        posts=[filtered.posts[0]],
    )
    assert json.loads(result.stdout) == expected_json(expected.to_dict())


def test_forum_find_passes_scan_budget_to_client(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    client, _ = patch_runtime(monkeypatch)

    result = runner.invoke(
        cli_module.cli,
        ["forum", "find", "deadline", "--limit-forums", "2", "--limit-discussions", "7", "--json"],
    )

    assert result.exit_code == 0
    assert client.forum_search_calls == [("deadline", 1, None, None, True, False, "recent", 2, 7)]


def test_forum_find_list_returns_shortlist_instead_of_single_hit(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    client, _ = patch_runtime(monkeypatch)

    result = runner.invoke(
        cli_module.cli,
        ["forum", "find", "deadline", "--list", "--limit", "2", "--json"],
    )

    assert result.exit_code == 0
    assert client.forum_search_calls == [("deadline", 2, None, None, True, False, "recent", None, None)]
    assert json.loads(result.stdout) == expected_json([hit.to_dict() for hit in FORUM_SEARCH_HITS[:2]])


def test_top_level_url_routes_forum_discussion_with_fragment(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    _, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, [f"{BASE_URL}/mod/forum/discuss.php?d=9001#p9101"])

    assert result.exit_code == 0
    text = normalize_terminal_text(result.output)
    assert "Discussion 9001" in text
    assert "9101" in text
    assert "9102" not in text


def test_top_level_url_routes_forum_view_to_discussions(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    _, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, [f"{BASE_URL}/mod/forum/view.php?id=501"])

    assert result.exit_code == 0
    text = normalize_terminal_text(result.output)
    assert "Forum 501: Discussions" in text
    assert "9001" in text
    assert "9002" in text


def test_top_level_url_routes_course_view(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    client, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, [f"{BASE_URL}/course/view.php?id=101"])

    assert result.exit_code == 0
    assert client.course_ids == [101]
    assert "Course 101" in result.output


def test_top_level_url_routes_grade_report(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    client, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, [f"{BASE_URL}/grade/report/user/index.php?id=101"])

    assert result.exit_code == 0
    assert client.grade_course_ids == [101]
    assert "Grades: Mathematics 101" in result.output


def test_top_level_url_rejects_unsupported_path(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    _, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, [f"{BASE_URL}/mod/assign/view.php?id=301"])

    assert result.exit_code == 2
    assert "Unsupported Moodle URL" in result.output


@pytest.mark.parametrize(
    ("args", "info", "loader", "expected", "texts"),
    [
        (
            ["update"],
            UpdateInfo(
                package_name="moodle-cli",
                current_version="0.2.1",
                latest_version="0.2.2",
                update_available=True,
                upgrade_commands=["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                pypi_url="https://pypi.org/project/moodle-cli/",
            ),
            None,
            None,
            ["Update available:", "0.2.2", "installed: 0.2.1", "uv tool upgrade moodle-cli"],
        ),
        (
            ["update", "--json"],
            UpdateInfo(
                package_name="moodle-cli",
                current_version="0.2.1",
                latest_version="0.2.2",
                update_available=True,
                upgrade_commands=["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                pypi_url="https://pypi.org/project/moodle-cli/",
            ),
            json.loads,
            {
                "package_name": "moodle-cli",
                "current_version": "0.2.1",
                "latest_version": "0.2.2",
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
                current_version="0.2.1",
                latest_version="0.2.2",
                update_available=True,
                upgrade_commands=["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                pypi_url="https://pypi.org/project/moodle-cli/",
            ),
            yaml.safe_load,
            {
                "package_name": "moodle-cli",
                "current_version": "0.2.1",
                "latest_version": "0.2.2",
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
                current_version="0.2.1",
                latest_version="0.2.1",
                update_available=False,
                upgrade_commands=["uv tool upgrade moodle-cli", "pipx upgrade moodle-cli"],
                pypi_url="https://pypi.org/project/moodle-cli/",
            ),
            None,
            None,
            ["moodle-cli is up to date", "(0.2.1)"],
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


def test_json_output_is_compact_and_prunes_empty_values(monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    _, _ = patch_runtime(monkeypatch)

    result = runner.invoke(cli_module.cli, ["overview", "--json"])

    assert result.exit_code == 0
    assert result.stdout.count("\n") == 1
    payload = json.loads(result.stdout)
    assert payload == expected_json(OVERVIEW.to_dict())
    assert '"errors"' not in result.stdout
    assert '"description"' not in result.stdout


@pytest.mark.parametrize("command", ["activities", "course", "grades"])
def test_course_commands_require_course_id(monkeypatch: pytest.MonkeyPatch, runner: CliRunner, command: str) -> None:
    monkeypatch.setattr(cli_module, "load_config", lambda: {"base_url": BASE_URL})

    result = runner.invoke(cli_module.cli, [command])

    assert result.exit_code == 2
    assert "Missing argument 'COURSE_ID'" in result.output
    assert "Run 'moodle courses' to list available course IDs" in result.output
    assert f"then retry with 'moodle {command} COURSE_ID'" in result.output


@pytest.mark.parametrize("command", ["activities", "course", "grades"])
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
        (["alerts"], "Loading alerts..."),
        (["todo"], "Loading todo items..."),
        (["overview"], "Loading overview..."),
        (["grades", "101"], "Loading grades for course 101..."),
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


def test_parse_page_context_allows_missing_fullname_when_session_data_exists() -> None:
    html = """
    <html lang="en">
      <head>
        <title>Dashboard | Campus</title>
        <script>
          var M = {};
          M.cfg = {"sesskey":"abc123","userId":56,"language":"en"};
        </script>
      </head>
      <body></body>
    </html>
    """

    context = scraper_module.parse_page_context(html, BASE_URL)

    assert context.sesskey == "abc123"
    assert context.user_info.userid == 56
    assert context.user_info.fullname == ""


def test_parse_course_grades_html_extracts_total_and_items() -> None:
    html = """
    <html>
      <body>
        <h1>Mathematics 101</h1>
        <h2><a>Alice Example</a></h2>
        <table class="user-grade">
          <tr>
            <th scope="row">
              <div class="item">
                <div><img class="itemicon" alt="Quiz" /></div>
                <div>
                  <div class="rowtitle"><a class="gradeitemheader" href="https://school.example.edu/mod/quiz/view.php?id=21">Quiz 1</a></div>
                </div>
              </div>
            </th>
            <td class="column-weight">100.00 %</td>
            <td class="column-grade"><div><i aria-label="Pass"></i>8.00</div><div class="action-menu">Actions</div></td>
            <td class="column-range">0-10</td>
            <td class="column-percentage">80.00 %</td>
            <td class="column-feedback">&nbsp;</td>
            <td class="column-contributiontocoursetotal">20.00 %</td>
          </tr>
          <tr>
            <th scope="row">
              <div class="courseitem">
                <div><img class="itemicon" alt="Natural" /></div>
                <div><div class="rowtitle"><span class="gradeitemheader" title="Course total">Course total</span></div></div>
              </div>
            </th>
            <td class="column-weight">-</td>
            <td class="column-grade">73.00</td>
            <td class="column-range">0-100</td>
            <td class="column-percentage">73.00 %</td>
            <td class="column-feedback">&nbsp;</td>
            <td class="column-contributiontocoursetotal">-</td>
          </tr>
        </table>
      </body>
    </html>
    """

    parsed = scraper_module.parse_course_grades_html(html, 101, BASE_URL)

    assert parsed.course_id == 101
    assert parsed.course_name == "Mathematics 101"
    assert parsed.learner_name == "Alice Example"
    assert parsed.total_grade == "73.00"
    assert parsed.total_percentage == "73.00 %"
    assert len(parsed.items) == 1
    assert parsed.items[0].name == "Quiz 1"
    assert parsed.items[0].item_type == "Quiz"
    assert parsed.items[0].grade == "8.00"
    assert parsed.items[0].status == "Pass"


def test_parse_course_grades_url_finds_course_nav_link() -> None:
    html = """
    <html>
      <body>
        <li data-key="grades"><a href="/grade/report/index.php?id=101">Grades</a></li>
      </body>
    </html>
    """

    assert scraper_module.parse_course_grades_url(html, BASE_URL) == f"{BASE_URL}/grade/report/index.php?id=101"


def test_parse_alert_summary_extracts_notifications_and_counts() -> None:
    parsed = cli_module.MoodleClient  # Keep imports in test module minimal.
    del parsed

    summary = scraper_module  # Avoid unused-import lint patterns.
    del summary

    from moodle_cli.parser import parse_alert_summary

    result = parse_alert_summary(
        {
            "notifications": [
                {
                    "id": 1,
                    "subject": "Due soon",
                    "shortenedsubject": "Due soon",
                    "eventtype": "assign_due",
                    "component": "mod_assign",
                    "timecreated": 123,
                    "timecreatedpretty": "just now",
                    "read": False,
                    "contexturl": "https://school.example.edu/mod/assign/view.php?id=1",
                    "contexturlname": "Assignment 1",
                }
            ]
        },
        {"favourites": 2, "types": {"1": 3, "2": 1, "3": 0}},
        {"favourites": 1, "types": {"1": 2, "2": 0, "3": 0}},
    )

    assert result.notification_count == 1
    assert result.unread_notification_count == 1
    assert result.starred_message_count == 2
    assert result.direct_message_count == 3
    assert result.unread_direct_message_count == 2


def test_course_to_dict_hides_past_enddate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(models_module.time, "time", lambda: 200)

    course = Course(id=1, shortname="TEST", fullname="Test Course", enddate=100)

    assert course.to_dict() == {
        "id": 1,
        "shortname": "TEST",
        "fullname": "Test Course",
        "category": 0,
        "visible": True,
        "startdate": 0,
    }


def test_course_to_dict_keeps_future_enddate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(models_module.time, "time", lambda: 200)

    course = Course(id=1, shortname="TEST", fullname="Test Course", enddate=300)

    assert course.to_dict() == {
        "id": 1,
        "shortname": "TEST",
        "fullname": "Test Course",
        "category": 0,
        "visible": True,
        "startdate": 0,
        "enddate": 300,
    }


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
    assert tmp_path.name in stderr
    assert ".config" in stderr
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
    assert "Tired of expired browser cookies? Try okta-auth" in stderr
    assert "https://github.com/bunizao/okta-auth" in stderr
    assert "Install with uv tool install okta-auth-cli, then run okta config." in stderr
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
    assert "Tired of expired browser cookies? Try okta-auth" in stderr
    assert "https://github.com/bunizao/okta-auth" in stderr
    assert "Install with uv tool install okta-auth-cli, then run okta config." in stderr
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


def test_main_renders_request_error_from_real_command(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class BrokenClient:
        def get_course_grades(self, _course_id: int) -> CourseGrades:
            raise MoodleRequestError("grade report unavailable")

    monkeypatch.setattr(cli_module, "load_config", lambda: {"base_url": BASE_URL})
    monkeypatch.setattr(cli_module, "get_session", lambda _base_url: "session-cookie")
    monkeypatch.setattr(cli_module, "MoodleClient", lambda *_args: BrokenClient())

    exit_code, stdout, stderr = run_main(monkeypatch, capsys, ["grades", "101"])

    assert exit_code == 1
    assert stdout == ""
    assert "Error: grade report unavailable" in stderr


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
