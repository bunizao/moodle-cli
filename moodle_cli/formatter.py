"""Rich terminal output: tables and trees for Moodle data."""

from datetime import datetime

from rich.console import Console
from rich.table import Table
from rich.text import Text
from rich.tree import Tree

from moodle_cli.models import Course, Section, TodoItem, UserInfo

console = Console()


def print_user_info(user: UserInfo) -> None:
    """Display authenticated user info."""
    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column(style="bold cyan")
    table.add_column()

    table.add_row("User", user.fullname)
    if user.username:
        table.add_row("Username", user.username)
    table.add_row("User ID", str(user.userid))
    table.add_row("Site", user.sitename)
    table.add_row("URL", user.siteurl)
    if user.lang:
        table.add_row("Language", user.lang)

    console.print(table)


def print_courses(courses: list[Course]) -> None:
    """Display enrolled courses as a table."""
    table = Table(title="Enrolled Courses")
    table.add_column("ID", style="dim", justify="right")
    table.add_column("Short Name", style="bold")
    table.add_column("Full Name")
    table.add_column("Visible", justify="center")

    for c in courses:
        visible = "[green]Yes[/]" if c.visible else "[red]No[/]"
        table.add_row(str(c.id), c.shortname, c.fullname, visible)

    console.print(table)


def print_course_contents(sections: list[Section], course_label: str = "Course") -> None:
    """Display course sections and activities as a tree."""
    tree = Tree(f"[bold]{course_label}[/bold]")

    for section in sections:
        label = section.name or f"Section {section.section}"
        if not section.visible:
            label += " [dim](hidden)[/dim]"
        branch = tree.add(f"[bold yellow]{label}[/bold yellow]")

        if not section.activities:
            branch.add("[dim]No activities[/dim]")
            continue

        for activity in section.activities:
            icon = _activity_icon(activity.modname)
            name = activity.name
            if not activity.visible:
                name += " [dim](hidden)[/dim]"
            branch.add(f"{icon} {name} [dim]({activity.modname})[/dim]")

    console.print(tree)


def print_todo_items(items: list[TodoItem]) -> None:
    """Display upcoming Moodle action events as a table."""
    table = Table(title="Todo")
    table.add_column("Due", style="cyan")
    table.add_column("Course", style="bold")
    table.add_column("Activity")
    table.add_column("Type", style="dim")
    table.add_column("Action", style="green")

    if not items:
        table.add_row("No upcoming items", "", "", "", "")
        console.print(table)
        return

    for item in items:
        due = _format_timestamp(item.due_at)
        if item.overdue:
            due = f"[red]{due}[/]"

        course_name = item.course_name
        if item.course_progress is not None:
            course_name = f"{course_name} ({item.course_progress}%)"

        activity_name = item.activity_name or item.name
        action = item.action_name if item.actionable else ""
        table.add_row(due, course_name, activity_name, item.modname or item.event_type, action)

    console.print(table)


def _activity_icon(modname: str) -> str:
    """Map Moodle module types to terminal-friendly icons."""
    icons = {
        "assign": "[red]A[/]",
        "quiz": "[magenta]Q[/]",
        "forum": "[green]F[/]",
        "resource": "[blue]R[/]",
        "url": "[cyan]U[/]",
        "page": "[white]P[/]",
        "folder": "[yellow]D[/]",
        "label": "[dim]L[/]",
        "choice": "[magenta]C[/]",
        "feedback": "[green]B[/]",
        "workshop": "[red]W[/]",
        "glossary": "[cyan]G[/]",
        "wiki": "[white]K[/]",
        "book": "[blue]B[/]",
        "h5pactivity": "[magenta]H[/]",
        "lti": "[yellow]E[/]",
    }
    return icons.get(modname, "[dim]·[/]")


def _format_timestamp(value: int) -> str:
    if value <= 0:
        return "-"
    return datetime.fromtimestamp(value).strftime("%Y-%m-%d %H:%M")
