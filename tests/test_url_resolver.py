from __future__ import annotations

import click
import pytest

from moodle_cli.url_resolver import ResolvedURLTarget, resolve_top_level_url

BASE_URL = "https://learning.monash.edu"


def test_resolve_rejects_different_host() -> None:
    with pytest.raises(click.UsageError, match="does not match configured Moodle site"):
        resolve_top_level_url(
            base_url=BASE_URL,
            target="https://monashuni.okta.com/app/example/sso/saml?RelayState=https%3A%2F%2Flearning.monash.edu%2Fcourse%2Fview.php%3Fid%3D101",
        )


def test_resolve_forum_discussion_with_fragment() -> None:
    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/mod/forum/discuss.php?d=9001#p9101",
    )

    assert resolved == ResolvedURLTarget(
        command_name="forum_discussion",
        kwargs={
            "discussion": "9001",
            "post_id": 9101,
            "show_body": False,
            "as_json": False,
            "as_yaml": False,
        },
    )


def test_resolve_forum_view() -> None:
    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/mod/forum/view.php?id=501",
    )

    assert resolved == ResolvedURLTarget(
        command_name="forum_discussions",
        kwargs={
            "forum": "501",
            "limit": 50,
            "as_json": False,
            "as_yaml": False,
        },
    )


def test_resolve_course_view() -> None:
    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/course/view.php?id=101",
    )

    assert resolved == ResolvedURLTarget(
        command_name="course",
        kwargs={"course_id": 101, "as_json": False, "as_yaml": False},
    )


def test_resolve_course_user_grade_page() -> None:
    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/course/user.php?mode=grade&id=101&user=7",
    )

    assert resolved == ResolvedURLTarget(
        command_name="grades",
        kwargs={"course_id": 101, "as_json": False, "as_yaml": False},
    )


def test_resolve_grade_report_page() -> None:
    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/grade/report/user/index.php?id=101",
    )

    assert resolved == ResolvedURLTarget(
        command_name="grades",
        kwargs={"course_id": 101, "as_json": False, "as_yaml": False},
    )


def test_resolve_assignment_page() -> None:
    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/mod/assign/view.php?id=5320744",
    )

    assert resolved == ResolvedURLTarget(
        command_name="assignment",
        kwargs={"assignment": "5320744", "as_json": False, "as_yaml": False},
    )


def test_resolve_quiz_page() -> None:
    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/mod/quiz/view.php?id=5235525",
    )

    assert resolved == ResolvedURLTarget(
        command_name="quiz",
        kwargs={"quiz": "5235525", "as_json": False, "as_yaml": False},
    )


def test_resolve_resource_page() -> None:
    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/mod/resource/view.php?id=7001",
    )

    assert resolved == ResolvedURLTarget(
        command_name="resource",
        kwargs={"resource": "7001", "as_json": False, "as_yaml": False},
    )


def test_resolve_link_page() -> None:
    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/mod/url/view.php?id=8001",
    )

    assert resolved == ResolvedURLTarget(
        command_name="link",
        kwargs={"link": "8001", "as_json": False, "as_yaml": False},
    )


def test_resolve_generic_activity_page_uses_callback() -> None:
    seen: list[str] = []

    def resolve_course_id(target: str) -> int | None:
        seen.append(target)
        return 41031

    resolved = resolve_top_level_url(
        base_url=BASE_URL,
        target=f"{BASE_URL}/mod/page/view.php?id=88",
        resolve_course_id_for_url=resolve_course_id,
    )

    assert seen == [f"{BASE_URL}/mod/page/view.php?id=88"]
    assert resolved == ResolvedURLTarget(
        command_name="course",
        kwargs={"course_id": 41031, "as_json": False, "as_yaml": False},
    )


def test_resolve_generic_activity_page_rejects_unknown_course() -> None:
    with pytest.raises(click.ClickException, match="Could not resolve course ID from the activity page"):
        resolve_top_level_url(
            base_url=BASE_URL,
            target=f"{BASE_URL}/mod/page/view.php?id=88",
            resolve_course_id_for_url=lambda _target: None,
        )


def test_resolve_rejects_unsupported_moodle_path() -> None:
    with pytest.raises(click.UsageError, match="Unsupported Moodle URL"):
        resolve_top_level_url(
            base_url=BASE_URL,
            target=f"{BASE_URL}/calendar/view.php?view=month",
        )
