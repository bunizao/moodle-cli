"""CLI entry point using Click."""

import logging
import sys
import webbrowser
from urllib.parse import parse_qs, urljoin, urlparse

import click
from rich.console import Console

from moodle_cli import __version__
from moodle_cli.auth import get_session
from moodle_cli.client import MoodleClient
from moodle_cli.config import load_config
from moodle_cli.constants import (
    LOGIN_PATH,
    OKTA_AUTH_CONFIG_COMMAND,
    OKTA_AUTH_INSTALL_COMMAND,
    OKTA_AUTH_URL,
)
from moodle_cli.exceptions import AuthError, MoodleAPIError, MoodleCLIError
from moodle_cli.formatter import (
    print_alerts,
    print_course_grades,
    print_courses,
    print_course_contents,
    print_forum_activities,
    print_forum_discussion,
    print_forum_search_hits,
    print_overview,
    print_todo_items,
    print_user_info,
)
from moodle_cli.output import output_json, output_yaml
from moodle_cli.update_check import check_for_updates

stdout_console = Console()
stderr_console = Console(stderr=True)


def _require_course_id(ctx: click.Context, course_id: int | None) -> int:
    """Validate a required course ID and show a helpful next step."""
    if course_id is not None:
        return course_id

    command_name = ctx.info_name or "course"
    raise click.UsageError(
        "Missing argument 'COURSE_ID'. Run 'moodle courses' to list available course IDs, "
        f"then retry with 'moodle {command_name} COURSE_ID'.",
        ctx=ctx,
    )


def _print_loading(message: str) -> None:
    """Print a short loading hint to stderr for slow network calls."""
    stderr_console.print(f"[dim]{message}[/]")


def _login_url(base_url: str) -> str:
    """Build the Moodle login URL from the configured site root."""
    return urljoin(f"{base_url.rstrip('/')}/", LOGIN_PATH.lstrip("/"))


def _open_login_page(base_url: str) -> bool:
    """Try to open the Moodle login page in the user's browser."""
    return bool(webbrowser.open(_login_url(base_url)))


def _print_okta_auth_hint() -> None:
    """Print a short hint about automatic session reuse via okta-auth."""
    stderr_console.print(
        "Tired of expired browser cookies? Try [bold cyan]okta-auth[/] for automatic "
        f"login and session reuse: [underline]{OKTA_AUTH_URL}[/]"
    )
    stderr_console.print(
        f"Install with [bold]{OKTA_AUTH_INSTALL_COMMAND}[/], then run "
        f"[bold]{OKTA_AUTH_CONFIG_COMMAND}[/]."
    )


def _parse_discussion_reference(value: str) -> tuple[int, int | None]:
    """Parse a discussion reference (ID or URL) into (discussion_id, post_id)."""
    raw = value.strip()
    if raw.isdigit():
        return int(raw), None

    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        raise click.UsageError("DISCUSSION must be a numeric ID or a full discuss.php URL.")

    query = parse_qs(parsed.query)
    discussion_values = query.get("d") or []
    if not discussion_values or not discussion_values[0].isdigit():
        raise click.UsageError("Could not find discussion ID in URL query (expected ?d=...).")

    discussion_id = int(discussion_values[0])
    post_id: int | None = None

    fragment = (parsed.fragment or "").strip()
    if fragment.startswith("p") and fragment[1:].isdigit():
        post_id = int(fragment[1:])

    return discussion_id, post_id


def _parse_forum_reference(ctx: click.Context, client: MoodleClient, value: str) -> int:
    """Parse a forum reference (course-module ID or URL) into a forum view course-module ID."""
    raw = value.strip()
    if raw.isdigit():
        return int(raw)

    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        raise click.UsageError("FORUM must be a numeric ID or a full forum URL.", ctx=ctx)

    query = parse_qs(parsed.query)

    if parsed.path.endswith("/mod/forum/view.php"):
        values = query.get("id") or []
        if not values or not values[0].isdigit():
            raise click.UsageError("Could not find forum module ID in view.php URL (expected ?id=...).", ctx=ctx)
        return int(values[0])

    if parsed.path.endswith("/mod/forum/discuss.php"):
        values = query.get("d") or []
        if not values or not values[0].isdigit():
            raise click.UsageError("Could not find discussion ID in discuss.php URL (expected ?d=...).", ctx=ctx)
        forum_cmid = client.get_forum_view_cmid(int(values[0]))
        if forum_cmid is None:
            raise click.ClickException("Could not resolve forum ID from the discussion page.")
        return forum_cmid

    raise click.UsageError("Unsupported forum URL. Use a view.php?id=... or discuss.php?d=... URL.", ctx=ctx)


def _parse_course_reference(ctx: click.Context, client: MoodleClient, value: str) -> int:
    """Parse a course reference (ID or unique name match) into a course ID."""
    raw = value.strip()
    if raw.isdigit():
        return int(raw)

    matches = [
        course
        for course in client.get_courses()
        if _query_matches_text(course.fullname, raw) or _query_matches_text(course.shortname, raw)
    ]
    if len(matches) == 1:
        return matches[0].id
    if not matches:
        raise click.UsageError(
            f"Could not find a course matching '{raw}'. Run 'moodle courses' to inspect course IDs.",
            ctx=ctx,
        )

    sample = ", ".join(f"{course.id}:{course.fullname or course.shortname}" for course in matches[:5])
    raise click.UsageError(f"Course '{raw}' is ambiguous. Matches: {sample}", ctx=ctx)


def _query_matches_text(text: str, query: str) -> bool:
    haystack = " ".join((text or "").lower().split())
    needle = " ".join((query or "").lower().split())
    if not needle:
        return True
    if needle in haystack:
        return True
    tokens = [token for token in needle.split(" ") if token]
    return bool(tokens) and all(token in haystack for token in tokens)


def _filter_discussion_to_post(discussion, post_id: int | None):
    """Keep only the matched post when a search result resolves to a specific post."""
    if post_id is None:
        return discussion

    filtered = [post for post in discussion.posts if post.id == post_id]
    if not filtered:
        raise click.ClickException(f"Post {post_id} was not found in discussion {discussion.id}.")

    from moodle_cli.models import ForumDiscussion

    return ForumDiscussion(
        id=discussion.id,
        subject=discussion.subject,
        course_id=discussion.course_id,
        forum_id=discussion.forum_id,
        url=discussion.url,
        posts=filtered,
    )


def _parse_query_int(query: dict[str, list[str]], key: str, label: str) -> int:
    values = query.get(key) or []
    if not values or not values[0].isdigit():
        raise click.UsageError(f"Could not find {label} in URL query (expected ?{key}=...).")
    return int(values[0])


def _dispatch_top_level_url(ctx: click.Context, target: str) -> None:
    parsed = urlparse(target.strip())
    if not parsed.scheme or not parsed.netloc:
        raise click.UsageError(f"No such command '{target}'.", ctx=ctx)

    path = parsed.path.rstrip("/")
    query = parse_qs(parsed.query)

    if path.endswith("/mod/forum/discuss.php"):
        discussion_id = _parse_query_int(query, "d", "discussion ID")
        post_id: int | None = None
        fragment = (parsed.fragment or "").strip()
        if fragment.startswith("p") and fragment[1:].isdigit():
            post_id = int(fragment[1:])
        ctx.invoke(
            forum_discussion,
            discussion=str(discussion_id),
            post_id=post_id,
            show_body=False,
            as_json=False,
            as_yaml=False,
        )
        return

    if path.endswith("/mod/forum/view.php"):
        forum_id = _parse_query_int(query, "id", "forum module ID")
        ctx.invoke(
            forum_discussions,
            forum=str(forum_id),
            limit=50,
            query=None,
            as_json=False,
            as_yaml=False,
        )
        return

    if path.endswith("/course/view.php"):
        course_id = _parse_query_int(query, "id", "course ID")
        ctx.invoke(course, course_id=course_id, as_json=False, as_yaml=False)
        return

    if "/grade/report/" in path:
        course_id = _parse_query_int(query, "id", "course ID")
        ctx.invoke(grades, course_id=course_id, as_json=False, as_yaml=False)
        return

    raise click.UsageError(
        "Unsupported Moodle URL. Supported paths: /mod/forum/discuss.php, /mod/forum/view.php, /course/view.php, /grade/report/*.",
        ctx=ctx,
    )


def _looks_like_url(value: str) -> bool:
    parsed = urlparse(value.strip())
    return bool(parsed.scheme and parsed.netloc)


class URLTargetGroup(click.Group):
    """Click group that treats a top-level URL as a routed target."""

    def resolve_command(self, ctx: click.Context, args: list[str]) -> tuple[str | None, click.Command, list[str]]:
        try:
            return super().resolve_command(ctx, args)
        except click.UsageError:
            if args and _looks_like_url(args[0]):
                command = self.get_command(ctx, "__url_target__")
                if command is not None:
                    return "__url_target__", command, args
            raise


@click.group(cls=URLTargetGroup)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
@click.version_option(version=__version__)
@click.pass_context
def cli(ctx: click.Context, verbose: bool) -> None:
    """Terminal-first CLI for Moodle LMS."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.WARNING,
        format="%(name)s: %(message)s",
    )

    ctx.ensure_object(dict)
    ctx.obj["_config"] = None

    def get_config() -> dict:
        if ctx.obj["_config"] is None:
            ctx.obj["_config"] = load_config()
        return ctx.obj["_config"]

    ctx.obj["get_config"] = get_config

    # Lazy client creation; only authenticate when a command needs it.
    ctx.obj["_client"] = None

    def get_client() -> MoodleClient:
        if ctx.obj["_client"] is None:
            config = get_config()
            session_cookie = get_session(config["base_url"])
            ctx.obj["_client"] = MoodleClient(config["base_url"], session_cookie)
        return ctx.obj["_client"]

    ctx.obj["get_client"] = get_client


@cli.command(name="__url_target__", hidden=True)
@click.argument("target", type=str, required=True)
@click.pass_context
def cli_url_target(ctx: click.Context, target: str) -> None:
    """Route a supported Moodle URL to the shortest existing command path."""
    _dispatch_top_level_url(ctx, target)


@cli.group()
def forum() -> None:
    """Forum utilities."""


@forum.command(name="discussion")
@click.argument("discussion", type=str, required=True)
@click.option("--post", "post_id", type=int, help="Show a specific post ID (defaults to #p... from URL).")
@click.option("--body", "show_body", is_flag=True, help="Show full post body (may be long).")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def forum_discussion(
    ctx: click.Context,
    discussion: str,
    post_id: int | None,
    show_body: bool,
    as_json: bool,
    as_yaml: bool,
) -> None:
    """Show posts in a forum discussion (DISCUSSION_ID or discuss.php URL)."""
    discussion_id, url_post_id = _parse_discussion_reference(discussion)
    if post_id is None:
        post_id = url_post_id

    _print_loading(f"Loading forum discussion {discussion_id}...")
    client = ctx.obj["get_client"]()
    thread = client.get_forum_discussion(discussion_id)

    if post_id is not None:
        filtered = [p for p in thread.posts if p.id == post_id]
        if not filtered:
            raise click.ClickException(f"Post {post_id} was not found in discussion {discussion_id}.")
        from moodle_cli.models import ForumDiscussion

        thread = ForumDiscussion(
            id=thread.id,
            subject=thread.subject,
            course_id=thread.course_id,
            forum_id=thread.forum_id,
            url=thread.url,
            posts=filtered,
        )

    if as_json:
        output_json(thread.to_dict())
    elif as_yaml:
        output_yaml(thread.to_dict())
    else:
        print_forum_discussion(thread, highlight_post_id=post_id, show_body=show_body)


@forum.command(name="discussions")
@click.argument("forum", type=str, required=True)
@click.option("--limit", type=click.IntRange(min=1), default=50, show_default=True, help="Maximum number of discussions.")
@click.option("--query", type=str, help="Filter discussion titles by query.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def forum_discussions(ctx: click.Context, forum: str, limit: int, query: str | None, as_json: bool, as_yaml: bool) -> None:
    """List discussions from a forum (FORUM_ID or view.php/discuss.php URL)."""
    client = ctx.obj["get_client"]()
    forum_cmid = _parse_forum_reference(ctx, client, forum)

    _print_loading(f"Loading forum discussions for forum {forum_cmid}...")
    refs = client.get_forum_discussion_refs(forum_cmid)
    if query:
        refs = [ref for ref in refs if _query_matches_text(ref.subject, query)]
    refs = refs[:limit]

    if as_json:
        output_json([ref.to_dict() for ref in refs])
    elif as_yaml:
        output_yaml([ref.to_dict() for ref in refs])
    else:
        from rich.table import Table

        table = Table(title=f"Forum {forum_cmid}: Discussions")
        table.add_column("Discussion ID", style="dim", justify="right")
        table.add_column("Subject", style="bold")
        table.add_column("URL")
        if not refs:
            table.add_row("No discussions", "", "")
        else:
            for ref in refs:
                table.add_row(str(ref.id), ref.subject, ref.url)
        stdout_console.print(table)


@forum.command(name="forums")
@click.argument("query", type=str, required=False)
@click.option("--course", "course_ref", type=str, help="Restrict to a course ID or unique course name match.")
@click.option("--limit", type=click.IntRange(min=1), default=50, show_default=True, help="Maximum number of forums.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def forum_forums(
    ctx: click.Context,
    query: str | None,
    course_ref: str | None,
    limit: int,
    as_json: bool,
    as_yaml: bool,
) -> None:
    """List forum activities, optionally filtered by course or query."""
    client = ctx.obj["get_client"]()
    course_id = _parse_course_reference(ctx, client, course_ref) if course_ref else None

    _print_loading("Loading forum activities...")
    forums = client.get_forums(course_id=course_id)
    if query:
        forums = [
            forum
            for forum in forums
            if _query_matches_text(forum.name, query) or _query_matches_text(forum.course_name, query)
        ]
    forums = forums[:limit]

    if as_json:
        output_json([forum.to_dict() for forum in forums])
    elif as_yaml:
        output_yaml([forum.to_dict() for forum in forums])
    else:
        print_forum_activities(forums)


@forum.command(name="search")
@click.argument("query", type=str, required=True)
@click.option("--course", "course_ref", type=str, help="Restrict to a course ID or unique course name match.")
@click.option("--forum", "forum_ref", type=str, help="Restrict to a forum ID or forum URL.")
@click.option("--titles-only", is_flag=True, help="Only search discussion titles.")
@click.option("--unread-only", is_flag=True, help="Only include unread discussion or post matches.")
@click.option("--recent", is_flag=True, help="Sort matches by newest activity instead of relevance.")
@click.option("--limit-forums", type=click.IntRange(min=1), help="Maximum number of forums to scan.")
@click.option("--limit-discussions", type=click.IntRange(min=1), help="Maximum number of discussions to scan per forum.")
@click.option("--limit", type=click.IntRange(min=1), default=20, show_default=True, help="Maximum number of matches.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def forum_search(
    ctx: click.Context,
    query: str,
    course_ref: str | None,
    forum_ref: str | None,
    titles_only: bool,
    unread_only: bool,
    recent: bool,
    limit_forums: int | None,
    limit_discussions: int | None,
    limit: int,
    as_json: bool,
    as_yaml: bool,
) -> None:
    """Search forums by discussion title or post text and return direct jump URLs."""
    client = ctx.obj["get_client"]()
    course_id = _parse_course_reference(ctx, client, course_ref) if course_ref else None
    forum_cmid = _parse_forum_reference(ctx, client, forum_ref) if forum_ref else None

    _print_loading(f"Searching forums for '{query}'...")
    hits = client.search_forum_content(
        query,
        limit=limit,
        course_id=course_id,
        forum_cmid=forum_cmid,
        include_post_text=not titles_only,
        unread_only=unread_only,
        sort_by="recent" if recent else "relevance",
        max_forums=limit_forums,
        max_discussions_per_forum=limit_discussions,
    )

    if as_json:
        output_json([hit.to_dict() for hit in hits])
    elif as_yaml:
        output_yaml([hit.to_dict() for hit in hits])
    else:
        print_forum_search_hits(hits)


@forum.command(name="find")
@click.argument("query", type=str, required=True)
@click.option("--course", "course_ref", type=str, help="Restrict to a course ID or unique course name match.")
@click.option("--forum", "forum_ref", type=str, help="Restrict to a forum ID or forum URL.")
@click.option("--titles-only", is_flag=True, help="Only search discussion titles.")
@click.option("--unread-only", is_flag=True, help="Only include unread discussion or post matches.")
@click.option("--body", "show_body", is_flag=True, help="Resolve the best match into the target post/discussion body.")
@click.option("--list", "list_mode", is_flag=True, help="Return a shortlist instead of only the single best match.")
@click.option("--limit-forums", type=click.IntRange(min=1), help="Maximum number of forums to scan.")
@click.option("--limit-discussions", type=click.IntRange(min=1), help="Maximum number of discussions to scan per forum.")
@click.option("--limit", type=click.IntRange(min=1), default=5, show_default=True, help="Maximum shortlist size when using --list.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def forum_find(
    ctx: click.Context,
    query: str,
    course_ref: str | None,
    forum_ref: str | None,
    titles_only: bool,
    unread_only: bool,
    show_body: bool,
    list_mode: bool,
    limit_forums: int | None,
    limit_discussions: int | None,
    limit: int,
    as_json: bool,
    as_yaml: bool,
) -> None:
    """Find the best forum match with shortest-path defaults for agent workflows."""
    client = ctx.obj["get_client"]()
    course_id = _parse_course_reference(ctx, client, course_ref) if course_ref else None
    forum_cmid = _parse_forum_reference(ctx, client, forum_ref) if forum_ref else None

    _print_loading(f"Finding best forum match for '{query}'...")
    hits = client.search_forum_content(
        query,
        limit=limit if list_mode else 1,
        course_id=course_id,
        forum_cmid=forum_cmid,
        include_post_text=not titles_only,
        unread_only=unread_only,
        sort_by="recent",
        max_forums=limit_forums,
        max_discussions_per_forum=limit_discussions,
    )
    hit = hits[0] if hits else None

    if show_body and hit is not None:
        discussion = client.get_forum_discussion(hit.discussion_id)
        discussion = _filter_discussion_to_post(discussion, hit.post_id or None)
        if as_json:
            output_json(discussion.to_dict())
        elif as_yaml:
            output_yaml(discussion.to_dict())
        else:
            print_forum_discussion(discussion, highlight_post_id=hit.post_id or None, show_body=True)
        return

    if list_mode:
        if as_json:
            output_json([item.to_dict() for item in hits])
        elif as_yaml:
            output_yaml([item.to_dict() for item in hits])
        else:
            print_forum_search_hits(hits)
        return

    if as_json:
        output_json(hit.to_dict() if hit is not None else None)
    elif as_yaml:
        output_yaml(hit.to_dict() if hit is not None else None)
    else:
        print_forum_search_hits([hit] if hit is not None else [])


@forum.command(name="check")
@click.argument("forum", type=str, required=True)
@click.option("--limit", type=click.IntRange(min=1), default=20, show_default=True, help="Maximum number of discussions to validate.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def forum_check(ctx: click.Context, forum: str, limit: int, as_json: bool, as_yaml: bool) -> None:
    """Validate that discussions in a forum can be opened and rendered."""
    client = ctx.obj["get_client"]()
    forum_cmid = _parse_forum_reference(ctx, client, forum)

    _print_loading(f"Loading forum discussions for forum {forum_cmid}...")
    refs = client.get_forum_discussion_refs(forum_cmid)[:limit]

    results: list[dict] = []
    for ref in refs:
        try:
            discussion = client.get_forum_discussion(ref.id)
            image_count = sum(len(post.image_urls) for post in discussion.posts)
            results.append(
                {
                    "discussion_id": ref.id,
                    "subject": ref.subject,
                    "ok": True,
                    "posts": len(discussion.posts),
                    "images": image_count,
                }
            )
        except Exception as exc:  # noqa: BLE001
            results.append(
                {
                    "discussion_id": ref.id,
                    "subject": ref.subject,
                    "ok": False,
                    "error": str(exc),
                }
            )

    if as_json:
        output_json(results)
    elif as_yaml:
        output_yaml(results)
    else:
        from rich.table import Table

        table = Table(title=f"Forum {forum_cmid}: Discussion Check (first {len(results)})")
        table.add_column("Discussion ID", style="dim", justify="right")
        table.add_column("OK", justify="center")
        table.add_column("Posts", style="cyan", justify="right")
        table.add_column("Images", style="dim", justify="right")
        table.add_column("Subject", style="bold")
        table.add_column("Error")

        for row in results:
            ok = "[green]Yes[/]" if row.get("ok") else "[red]No[/]"
            table.add_row(
                str(row.get("discussion_id", "")),
                ok,
                str(row.get("posts", "")) if row.get("ok") else "",
                str(row.get("images", "")) if row.get("ok") else "",
                row.get("subject", ""),
                row.get("error", ""),
            )

        stdout_console.print(table)


@cli.command(name="user")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def user(ctx: click.Context, as_json: bool, as_yaml: bool) -> None:
    """Show authenticated user info."""
    client = ctx.obj["get_client"]()
    info = client.get_site_info()

    if as_json:
        output_json(info.to_dict())
    elif as_yaml:
        output_yaml(info.to_dict())
    else:
        print_user_info(info)


@cli.command()
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def courses(ctx: click.Context, as_json: bool, as_yaml: bool) -> None:
    """List enrolled courses."""
    _print_loading("Loading courses...")
    client = ctx.obj["get_client"]()
    course_list = client.get_courses()

    if as_json:
        output_json([c.to_dict() for c in course_list])
    elif as_yaml:
        output_yaml([c.to_dict() for c in course_list])
    else:
        print_courses(course_list)


@cli.command()
@click.option("--limit", type=click.IntRange(min=1), default=20, show_default=True, help="Maximum number of items.")
@click.option("--days", type=click.IntRange(min=1), help="Only include items due within the next N days.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def todo(ctx: click.Context, limit: int, days: int | None, as_json: bool, as_yaml: bool) -> None:
    """List upcoming actionable timeline items."""
    _print_loading("Loading todo items...")
    client = ctx.obj["get_client"]()
    items = client.get_todo(limit=limit, days=days)

    if as_json:
        output_json([item.to_dict() for item in items])
    elif as_yaml:
        output_yaml([item.to_dict() for item in items])
    else:
        print_todo_items(items)


@cli.command()
@click.option("--limit", type=click.IntRange(min=1), default=20, show_default=True, help="Maximum number of notifications.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def alerts(ctx: click.Context, limit: int, as_json: bool, as_yaml: bool) -> None:
    """List notifications and message counts."""
    _print_loading("Loading alerts...")
    client = ctx.obj["get_client"]()
    alerts_summary = client.get_alerts(limit=limit)

    if as_json:
        output_json(alerts_summary.to_dict())
    elif as_yaml:
        output_yaml(alerts_summary.to_dict())
    else:
        print_alerts(alerts_summary)


@cli.command()
@click.option("--todo-limit", type=click.IntRange(min=1), default=5, show_default=True, help="Maximum number of todo items.")
@click.option("--todo-days", type=click.IntRange(min=1), help="Only include todo items due within the next N days.")
@click.option("--alerts-limit", type=click.IntRange(min=1), default=5, show_default=True, help="Maximum number of notifications.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def overview(
    ctx: click.Context,
    todo_limit: int,
    todo_days: int | None,
    alerts_limit: int,
    as_json: bool,
    as_yaml: bool,
) -> None:
    """Show a compact multi-source overview."""
    _print_loading("Loading overview...")
    client = ctx.obj["get_client"]()
    overview_data = client.get_overview(todo_limit=todo_limit, todo_days=todo_days, alerts_limit=alerts_limit)

    if as_json:
        output_json(overview_data.to_dict())
    elif as_yaml:
        output_yaml(overview_data.to_dict())
    else:
        print_overview(overview_data)


@cli.command()
@click.argument("course_id", type=int, required=False)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def grades(ctx: click.Context, course_id: int | None, as_json: bool, as_yaml: bool) -> None:
    """Show grade details for a course."""
    course_id = _require_course_id(ctx, course_id)
    _print_loading(f"Loading grades for course {course_id}...")
    client = ctx.obj["get_client"]()
    course_grades = client.get_course_grades(course_id)

    if as_json:
        output_json(course_grades.to_dict())
    elif as_yaml:
        output_yaml(course_grades.to_dict())
    else:
        print_course_grades(course_grades)


@cli.command(name="update")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
def update(as_json: bool, as_yaml: bool) -> None:
    """Check whether a newer moodle-cli version is available."""
    _print_loading("Checking for updates...")
    info = check_for_updates()

    if as_json:
        output_json(info.to_dict())
    elif as_yaml:
        output_yaml(info.to_dict())
    elif info.update_available:
        stdout_console.print(
            f"[yellow]Update available:[/] {info.latest_version} "
            f"(installed: {info.current_version})"
        )
        stdout_console.print("Upgrade with:")
        for command in info.upgrade_commands:
            stdout_console.print(f"  {command}")
    else:
        stdout_console.print(f"[green]{info.package_name} is up to date[/] ({info.current_version})")


@cli.command()
@click.argument("course_id", type=int, required=False)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def activities(ctx: click.Context, course_id: int | None, as_json: bool, as_yaml: bool) -> None:
    """List activities in a course (sections and modules)."""
    course_id = _require_course_id(ctx, course_id)
    _print_loading(f"Loading activities for course {course_id}...")
    client = ctx.obj["get_client"]()
    sections = client.get_course_contents(course_id)

    if as_json:
        output_json([s.to_dict() for s in sections])
    elif as_yaml:
        output_yaml([s.to_dict() for s in sections])
    else:
        print_course_contents(sections, course_label=f"Course {course_id}")


@cli.command()
@click.argument("course_id", type=int, required=False)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def course(ctx: click.Context, course_id: int | None, as_json: bool, as_yaml: bool) -> None:
    """Show course detail with sections."""
    course_id = _require_course_id(ctx, course_id)
    _print_loading(f"Loading course {course_id}...")
    client = ctx.obj["get_client"]()
    sections = client.get_course_contents(course_id)

    if as_json:
        output_json([s.to_dict() for s in sections])
    elif as_yaml:
        output_yaml([s.to_dict() for s in sections])
    else:
        print_course_contents(sections, course_label=f"Course {course_id}")


def main() -> None:
    """Entry point with error handling."""
    try:
        cli(standalone_mode=False)
    except click.exceptions.Abort:
        sys.exit(130)
    except click.exceptions.Exit as e:
        sys.exit(e.exit_code)
    except click.ClickException as e:
        e.show()
        sys.exit(e.exit_code)
    except AuthError as e:
        stderr_console.print(f"[bold red]Auth error:[/] {e}")
        _print_okta_auth_hint()
        try:
            base_url = load_config()["base_url"]
        except (MoodleCLIError, click.ClickException):
            base_url = None

        if base_url:
            login_url = _login_url(base_url)
            if _open_login_page(base_url):
                stderr_console.print(f"Opened browser login page: {login_url}")
            else:
                stderr_console.print(f"Open this login page in your browser: {login_url}")
            stderr_console.print("Log in there, then rerun the command.")
        sys.exit(1)
    except MoodleAPIError as e:
        stderr_console.print(f"[bold red]API error:[/] {e}")
        if e.error_code:
            stderr_console.print(f"  Error code: {e.error_code}")
        sys.exit(1)
    except MoodleCLIError as e:
        stderr_console.print(f"[bold red]Error:[/] {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
