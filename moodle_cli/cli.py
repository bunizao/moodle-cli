"""CLI entry point using Click."""

import logging
import sys
import webbrowser
from urllib.parse import urljoin

import click
from rich.console import Console

from moodle_cli import __version__
from moodle_cli.auth import get_session
from moodle_cli.client import MoodleClient
from moodle_cli.config import load_config
from moodle_cli.constants import LOGIN_PATH
from moodle_cli.exceptions import AuthError, MoodleAPIError, MoodleCLIError
from moodle_cli.formatter import (
    print_alerts,
    print_course_grades,
    print_courses,
    print_course_contents,
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


@click.group()
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
