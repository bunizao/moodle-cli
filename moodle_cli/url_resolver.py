"""Resolve top-level Moodle URLs into CLI command targets."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable
from urllib.parse import parse_qs, urlparse

import click


@dataclass(frozen=True)
class ResolvedURLTarget:
    command_name: str
    kwargs: dict


def resolve_top_level_url(
    *,
    base_url: str,
    target: str,
    resolve_course_id_for_url: Callable[[str], int | None] | None = None,
) -> ResolvedURLTarget:
    """Resolve a supported Moodle URL into a CLI command and arguments."""
    parsed = urlparse(target.strip())
    if not parsed.scheme or not parsed.netloc:
        raise click.UsageError(f"No such command '{target}'.")

    _require_configured_site_host(base_url, parsed.netloc)

    path = parsed.path.rstrip("/")
    query = parse_qs(parsed.query)

    if path.endswith("/mod/forum/discuss.php"):
        post_id: int | None = None
        fragment = (parsed.fragment or "").strip()
        if fragment.startswith("p") and fragment[1:].isdigit():
            post_id = int(fragment[1:])
        return ResolvedURLTarget(
            command_name="forum_discussion",
            kwargs={
                "discussion": str(_parse_query_int(query, "d", "discussion ID")),
                "post_id": post_id,
                "show_body": False,
                "as_json": False,
                "as_yaml": False,
            },
        )

    if path.endswith("/mod/forum/view.php"):
        return ResolvedURLTarget(
            command_name="forum_discussions",
            kwargs={
                "forum": str(_parse_query_int(query, "id", "forum module ID")),
                "limit": 50,
                "as_json": False,
                "as_yaml": False,
            },
        )

    if path.endswith("/mod/assign/view.php"):
        return ResolvedURLTarget(
            command_name="assignment",
            kwargs={
                "assignment": str(_parse_query_int(query, "id", "assignment module ID")),
                "as_json": False,
                "as_yaml": False,
            },
        )

    if path.endswith("/mod/quiz/view.php"):
        return ResolvedURLTarget(
            command_name="quiz",
            kwargs={
                "quiz": str(_parse_query_int(query, "id", "quiz module ID")),
                "as_json": False,
                "as_yaml": False,
            },
        )

    if path.endswith("/mod/resource/view.php"):
        return ResolvedURLTarget(
            command_name="resource",
            kwargs={
                "resource": str(_parse_query_int(query, "id", "resource module ID")),
                "as_json": False,
                "as_yaml": False,
            },
        )

    if path.endswith("/mod/url/view.php"):
        return ResolvedURLTarget(
            command_name="link",
            kwargs={
                "link": str(_parse_query_int(query, "id", "link module ID")),
                "as_json": False,
                "as_yaml": False,
            },
        )

    if path.endswith("/course/view.php"):
        return ResolvedURLTarget(
            command_name="course",
            kwargs={
                "course_id": _parse_query_int(query, "id", "course ID"),
                "as_json": False,
                "as_yaml": False,
            },
        )

    if path.endswith("/course/user.php") and ((query.get("mode") or [""])[0] == "grade"):
        return ResolvedURLTarget(
            command_name="grades",
            kwargs={
                "course_id": _parse_query_int(query, "id", "course ID"),
                "as_json": False,
                "as_yaml": False,
            },
        )

    if "/grade/report/" in path:
        return ResolvedURLTarget(
            command_name="grades",
            kwargs={
                "course_id": _parse_query_int(query, "id", "course ID"),
                "as_json": False,
                "as_yaml": False,
            },
        )

    if path.startswith("/mod/") and path.endswith("/view.php"):
        _parse_query_int(query, "id", "activity module ID")
        if resolve_course_id_for_url is None:
            raise click.ClickException("Could not resolve course ID from the activity page.")
        course_id = resolve_course_id_for_url(target)
        if course_id is None:
            raise click.ClickException("Could not resolve course ID from the activity page.")
        return ResolvedURLTarget(
            command_name="course",
            kwargs={"course_id": course_id, "as_json": False, "as_yaml": False},
        )

    raise click.UsageError(
        "Unsupported Moodle URL. Supported paths: /mod/forum/discuss.php, /mod/forum/view.php, /mod/*/view.php, /course/view.php, /course/user.php?mode=grade, /grade/report/*."
    )


def _parse_query_int(query: dict[str, list[str]], key: str, label: str) -> int:
    values = query.get(key) or []
    if not values or not values[0].isdigit():
        raise click.UsageError(f"Could not find {label} in URL query (expected ?{key}=...).")
    return int(values[0])


def _require_configured_site_host(base_url: str, target_host: str) -> None:
    configured_host = urlparse(base_url).netloc.lower()
    normalized_target_host = target_host.lower()

    if normalized_target_host == configured_host:
        return

    raise click.UsageError(
        f"URL host '{normalized_target_host}' does not match configured Moodle site '{configured_host}'. "
        "Paste the Moodle page URL, not an external login redirect."
    )
