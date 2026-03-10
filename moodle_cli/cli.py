"""CLI entry point using Click."""

import logging
import sys

import click
from rich.console import Console

from moodle_cli import __version__
from moodle_cli.auth import get_session
from moodle_cli.client import MoodleClient
from moodle_cli.config import load_config
from moodle_cli.exceptions import AuthError, MoodleAPIError, MoodleCLIError
from moodle_cli.formatter import print_courses, print_course_contents, print_user_info
from moodle_cli.output import output_json, output_yaml

console = Console(stderr=True)


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

    config = load_config()
    ctx.ensure_object(dict)
    ctx.obj["config"] = config

    # Lazy client creation; only authenticate when a command needs it.
    ctx.obj["_client"] = None

    def get_client() -> MoodleClient:
        if ctx.obj["_client"] is None:
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
    client = ctx.obj["get_client"]()
    course_list = client.get_courses()

    if as_json:
        output_json([c.to_dict() for c in course_list])
    elif as_yaml:
        output_yaml([c.to_dict() for c in course_list])
    else:
        print_courses(course_list)


@cli.command()
@click.argument("course_id", type=int)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def activities(ctx: click.Context, course_id: int, as_json: bool, as_yaml: bool) -> None:
    """List activities in a course (sections and modules)."""
    client = ctx.obj["get_client"]()
    sections = client.get_course_contents(course_id)

    if as_json:
        output_json([s.to_dict() for s in sections])
    elif as_yaml:
        output_yaml([s.to_dict() for s in sections])
    else:
        print_course_contents(sections, course_label=f"Course {course_id}")


@cli.command()
@click.argument("course_id", type=int)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def course(ctx: click.Context, course_id: int, as_json: bool, as_yaml: bool) -> None:
    """Show course detail with sections."""
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
        console.print(f"[bold red]Auth error:[/] {e}")
        sys.exit(1)
    except MoodleAPIError as e:
        console.print(f"[bold red]API error:[/] {e}")
        if e.error_code:
            console.print(f"  Error code: {e.error_code}")
        sys.exit(1)
    except MoodleCLIError as e:
        console.print(f"[bold red]Error:[/] {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
