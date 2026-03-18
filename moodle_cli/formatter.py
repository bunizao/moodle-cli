"""Rich terminal output: tables and trees for Moodle data."""

from datetime import datetime

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

from moodle_cli.models import AlertSummary, Assignment, Course, CourseGrades, ForumDiscussion, ForumPost, Link, Overview, Quiz, Resource, Section, TodoItem, UserInfo

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


def print_course_grades(course_grades: CourseGrades) -> None:
    """Display a course grade report."""
    summary = Table(title=f"Grades: {course_grades.course_name}", show_header=False, box=None, padding=(0, 2))
    summary.add_column(style="bold cyan")
    summary.add_column()

    if course_grades.learner_name:
        summary.add_row("Learner", course_grades.learner_name)
    if course_grades.total_grade:
        summary.add_row("Course Total", course_grades.total_grade)
    if course_grades.total_percentage:
        summary.add_row("Percentage", course_grades.total_percentage)
    if course_grades.total_range:
        summary.add_row("Range", course_grades.total_range)
    console.print(summary)

    table = Table(title="Grade Items")
    table.add_column("Item", style="bold")
    table.add_column("Type", style="dim")
    table.add_column("Grade")

    show_range = any(item.range for item in course_grades.items)
    show_percent = any(item.percentage for item in course_grades.items)
    show_weight = any(item.weight for item in course_grades.items)
    show_contribution = any(item.contribution for item in course_grades.items)
    show_feedback = any(item.feedback for item in course_grades.items)
    show_status = any(item.status for item in course_grades.items)

    if show_range:
        table.add_column("Range")
    if show_percent:
        table.add_column("Percent")
    if show_weight:
        table.add_column("Weight")
    if show_contribution:
        table.add_column("Contribution")
    if show_feedback:
        table.add_column("Feedback")
    if show_status:
        table.add_column("Status", style="green")

    if not course_grades.items:
        empty_cells = ["No grade items", "", ""]
        if show_range:
            empty_cells.append("")
        if show_percent:
            empty_cells.append("")
        if show_weight:
            empty_cells.append("")
        if show_contribution:
            empty_cells.append("")
        if show_feedback:
            empty_cells.append("")
        if show_status:
            empty_cells.append("")
        table.add_row(*empty_cells)
        console.print(table)
        return

    for item in course_grades.items:
        row = [
            item.name,
            item.item_type,
            item.grade or "-",
        ]
        if show_range:
            row.append(item.range or "-")
        if show_percent:
            row.append(item.percentage or "-")
        if show_weight:
            row.append(item.weight or "-")
        if show_contribution:
            row.append(item.contribution or "-")
        if show_feedback:
            row.append(item.feedback or "-")
        if show_status:
            row.append(item.status)
        table.add_row(*row)

    console.print(table)


def print_assignment(assignment: Assignment) -> None:
    """Display a Moodle assignment summary."""
    table = Table(title=f"Assignment: {assignment.name}", show_header=False, box=None, padding=(0, 2))
    table.add_column(style="bold cyan")
    table.add_column()

    if assignment.course_name:
        table.add_row("Course", assignment.course_name)
    if assignment.section_name:
        table.add_row("Section", assignment.section_name)
    if assignment.due_pretty:
        table.add_row("Due", assignment.due_pretty)
    if assignment.submission_status:
        table.add_row("Submission", assignment.submission_status)
    if assignment.grading_status:
        table.add_row("Grading", assignment.grading_status)
    if assignment.time_remaining:
        table.add_row("Time Remaining", assignment.time_remaining)
    if assignment.grade:
        table.add_row("Grade", assignment.grade)
    if assignment.url:
        table.add_row("URL", assignment.url)

    console.print(table)


def print_quiz(quiz: Quiz) -> None:
    """Display a Moodle quiz summary."""
    table = Table(title=f"Quiz: {quiz.name}", show_header=False, box=None, padding=(0, 2))
    table.add_column(style="bold cyan")
    table.add_column()

    if quiz.course_name:
        table.add_row("Course", quiz.course_name)
    if quiz.section_name:
        table.add_row("Section", quiz.section_name)
    if quiz.opens_pretty:
        table.add_row("Opens", quiz.opens_pretty)
    if quiz.closes_pretty:
        table.add_row("Closes", quiz.closes_pretty)
    if quiz.attempts_allowed:
        table.add_row("Attempts", quiz.attempts_allowed)
    if quiz.availability:
        table.add_row("Availability", quiz.availability)
    if quiz.grade:
        table.add_row("Grade", quiz.grade)
    if quiz.url:
        table.add_row("URL", quiz.url)

    console.print(table)


def print_resource(resource: Resource) -> None:
    """Display a Moodle file/resource summary."""
    table = Table(title=f"Resource: {resource.name}", show_header=False, box=None, padding=(0, 2))
    table.add_column(style="bold cyan")
    table.add_column()

    if resource.course_name:
        table.add_row("Course", resource.course_name)
    if resource.section_name:
        table.add_row("Section", resource.section_name)
    if resource.target_name:
        table.add_row("Target", resource.target_name)
    if resource.target_url:
        table.add_row("URL", resource.target_url)
    elif resource.url:
        table.add_row("URL", resource.url)

    console.print(table)


def print_link(link: Link) -> None:
    """Display a Moodle external-link summary."""
    table = Table(title=f"Link: {link.name}", show_header=False, box=None, padding=(0, 2))
    table.add_column(style="bold cyan")
    table.add_column()

    if link.course_name:
        table.add_row("Course", link.course_name)
    if link.section_name:
        table.add_row("Section", link.section_name)
    if link.target_url:
        table.add_row("Target", link.target_url)
    if link.url:
        table.add_row("URL", link.url)

    console.print(table)


def print_alerts(alerts: AlertSummary) -> None:
    """Display notifications and message counts."""
    summary = Table(title="Alerts", show_header=False, box=None, padding=(0, 2))
    summary.add_column(style="bold cyan")
    summary.add_column()
    summary.add_row("Notifications", str(alerts.notification_count))
    summary.add_row("Unread Notifications", str(alerts.unread_notification_count))
    summary.add_row("Direct Messages", str(alerts.direct_message_count))
    summary.add_row("Unread Direct", str(alerts.unread_direct_message_count))
    summary.add_row("Group Messages", str(alerts.group_message_count))
    summary.add_row("Unread Group", str(alerts.unread_group_message_count))
    summary.add_row("Starred", str(alerts.starred_message_count))
    summary.add_row("Unread Starred", str(alerts.unread_starred_message_count))
    console.print(summary)

    table = Table(title="Notifications")
    table.add_column("When", style="cyan")
    table.add_column("Subject", style="bold")
    table.add_column("Type", style="dim")
    table.add_column("Link")

    if not alerts.notifications:
        table.add_row("No notifications", "", "", "")
        console.print(table)
        return

    for notification in alerts.notifications:
        table.add_row(
            notification.created_pretty or _format_timestamp(notification.created_at),
            notification.short_subject or notification.subject,
            notification.event_type or notification.component,
            notification.context_name or notification.context_url,
        )

    console.print(table)


def print_overview(overview: Overview) -> None:
    """Display a compact cross-command summary."""
    summary = Table(title="Overview", show_header=False, box=None, padding=(0, 2))
    summary.add_column(style="bold cyan")
    summary.add_column()
    summary.add_row("User", overview.user.fullname or str(overview.user.userid))
    summary.add_row("Courses", str(len(overview.courses)))
    summary.add_row("Todo Items", str(len(overview.todo)))

    if overview.alerts is not None:
        summary.add_row("Unread Notifications", str(overview.alerts.unread_notification_count))
        summary.add_row("Unread Direct Messages", str(overview.alerts.unread_direct_message_count))

    if overview.errors:
        summary.add_row("Warnings", str(len(overview.errors)))

    console.print(summary)

    if overview.todo:
        print_todo_items(overview.todo)

    if overview.alerts is not None:
        print_alerts(overview.alerts)

    if overview.errors:
        console.print(Panel("\n".join(overview.errors), title="Warnings", border_style="yellow"))


def print_forum_discussion(discussion: ForumDiscussion, highlight_post_id: int | None = None, show_body: bool = False) -> None:
    """Display a forum discussion as a table of posts."""
    header = Table(show_header=False, box=None, padding=(0, 2))
    header.add_column(style="bold cyan")
    header.add_column()
    header.add_row("Discussion", str(discussion.id))
    if discussion.subject:
        header.add_row("Subject", discussion.subject)
    if discussion.url:
        header.add_row("URL", discussion.url)
    if discussion.course_id:
        header.add_row("Course ID", str(discussion.course_id))
    if discussion.forum_id:
        header.add_row("Forum ID", str(discussion.forum_id))
    console.print(header)

    if show_body:
        if not discussion.posts:
            console.print(Panel("No posts", title="Posts", border_style="dim"))
            return

        for post in discussion.posts:
            when = post.created_pretty or (_format_timestamp(post.time_created) if post.time_created else "-")
            title = f"Post {post.id}"
            if highlight_post_id is not None and post.id == highlight_post_id:
                title = f"[bold yellow]{title}[/]"

            body_parts: list[str] = []
            if post.subject:
                body_parts.append(f"[bold]{post.subject}[/]")
            body_parts.append(f"[dim]Author:[/] {post.author.fullname or '-'}")
            body_parts.append(f"[dim]When:[/] {when}")
            if post.url:
                body_parts.append(f"[dim]URL:[/] {post.url}")
            if post.message_text:
                body_parts.append("")
                body_parts.append(post.message_text)
            if post.image_urls:
                body_parts.append("")
                body_parts.append("[dim]Images:[/]")
                body_parts.extend([f"- {url}" for url in post.image_urls])

            console.print(Panel("\n".join(body_parts), title=title, border_style="cyan"))

        return

    table = Table(title="Posts")
    table.add_column("Post ID", style="dim", justify="right")
    table.add_column("Author", style="bold")
    table.add_column("When", style="cyan")
    table.add_column("Subject")
    table.add_column("Unread", justify="center")
    table.add_column("Images", style="dim", justify="right")
    table.add_column("Preview")

    if not discussion.posts:
        table.add_row("No posts", "", "", "", "", "", "")
        console.print(table)
        return

    for post in discussion.posts:
        table.add_row(*_forum_post_row(post, highlight_post_id=highlight_post_id, show_body=show_body))

    console.print(table)


def _forum_post_row(post: ForumPost, highlight_post_id: int | None, show_body: bool) -> list[str]:
    post_id_cell = str(post.id)
    if highlight_post_id is not None and post.id == highlight_post_id:
        post_id_cell = f"[bold yellow]{post_id_cell}[/]"

    when = post.created_pretty or (_format_timestamp(post.time_created) if post.time_created else "-")
    unread = "[green]Yes[/]" if post.unread else ""
    subject = post.subject or ""

    if show_body:
        preview = post.message_text or ""
    else:
        preview = _truncate_preview(post.message_text)

    author = post.author.fullname or str(post.author.id) if post.author.id else ""
    if not author:
        author = "-"

    return [post_id_cell, author, when, subject, unread, str(len(post.image_urls) if post.image_urls else ""), preview]


def _truncate_preview(text: str, max_len: int = 100) -> str:
    cleaned = " ".join((text or "").split())
    if len(cleaned) <= max_len:
        return cleaned
    return f"{cleaned[: max_len - 1]}…"


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
