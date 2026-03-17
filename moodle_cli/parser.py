"""Parse raw Moodle JSON responses into typed models."""

from moodle_cli.html_utils import html_to_structured_content
from moodle_cli.models import (
    Activity,
    AlertNotification,
    AlertSummary,
    Course,
    ForumDiscussion,
    ForumPost,
    ForumPostAuthor,
    Section,
    TodoItem,
    UserInfo,
)


def parse_user_info(data: dict) -> UserInfo:
    return UserInfo(
        userid=data["userid"],
        username=data["username"],
        fullname=data["fullname"],
        sitename=data["sitename"],
        siteurl=data["siteurl"],
        lang=data.get("lang", ""),
    )


def parse_course(data: dict) -> Course:
    return Course(
        id=data["id"],
        shortname=data.get("shortname", ""),
        fullname=data.get("fullname", ""),
        category=data.get("category", 0),
        visible=bool(data.get("visible", True)),
        startdate=data.get("startdate", 0),
        enddate=data.get("enddate", 0),
    )


def parse_courses(data: list[dict]) -> list[Course]:
    return [parse_course(c) for c in data]


def parse_activity(data: dict) -> Activity:
    return Activity(
        id=data["id"],
        name=data.get("name", ""),
        modname=data.get("modname", ""),
        url=data.get("url", ""),
        visible=bool(data.get("visible", True)),
        description=data.get("description", ""),
    )


def parse_section(data: dict) -> Section:
    modules = data.get("modules", [])
    return Section(
        id=data["id"],
        name=data.get("name", ""),
        section=data.get("section", 0),
        visible=bool(data.get("visible", True)),
        summary=data.get("summary", ""),
        activities=[parse_activity(m) for m in modules],
    )


def parse_course_contents(data: list[dict]) -> list[Section]:
    return [parse_section(s) for s in data]


def parse_todo_item(data: dict) -> TodoItem:
    course = data.get("course", {})
    action = data.get("action", {})
    progress = course.get("progress")

    return TodoItem(
        id=data["id"],
        name=data.get("name", ""),
        activity_name=data.get("activityname", ""),
        modname=data.get("modulename", ""),
        course_id=course.get("id", 0),
        course_name=course.get("fullname", ""),
        due_at=data.get("timesort") or data.get("timestart") or 0,
        overdue=bool(data.get("overdue", False)),
        actionable=bool(action.get("actionable", False)),
        action_name=action.get("name", ""),
        action_url=action.get("url", ""),
        url=data.get("url", ""),
        event_type=data.get("eventtype", ""),
        course_progress=progress if isinstance(progress, int) else None,
    )


def parse_todo_items(data: list[dict]) -> list[TodoItem]:
    return [parse_todo_item(item) for item in data]


def parse_alert_notification(data: dict) -> AlertNotification:
    return AlertNotification(
        id=data["id"],
        subject=data.get("subject", ""),
        short_subject=data.get("shortenedsubject", ""),
        event_type=data.get("eventtype", ""),
        component=data.get("component", ""),
        created_at=data.get("timecreated", 0),
        created_pretty=data.get("timecreatedpretty", ""),
        read=bool(data.get("read", False)),
        context_url=data.get("contexturl", ""),
        context_name=data.get("contexturlname", ""),
    )


def parse_alert_notifications(data: list[dict]) -> list[AlertNotification]:
    return [parse_alert_notification(item) for item in data]


def parse_alert_summary(notifications_data: dict, counts_data: dict, unread_counts_data: dict) -> AlertSummary:
    notifications = parse_alert_notifications(notifications_data.get("notifications", []))
    types = counts_data.get("types", {})
    unread_types = unread_counts_data.get("types", {})

    return AlertSummary(
        notifications=notifications,
        notification_count=len(notifications),
        unread_notification_count=sum(1 for notification in notifications if not notification.read),
        starred_message_count=counts_data.get("favourites", 0),
        direct_message_count=types.get("1", 0),
        group_message_count=types.get("2", 0),
        self_message_count=types.get("3", 0),
        unread_starred_message_count=unread_counts_data.get("favourites", 0),
        unread_direct_message_count=unread_types.get("1", 0),
        unread_group_message_count=unread_types.get("2", 0),
        unread_self_message_count=unread_types.get("3", 0),
    )


def parse_forum_post_author(data: dict) -> ForumPostAuthor:
    urls = data.get("urls", {}) if isinstance(data.get("urls"), dict) else {}
    return ForumPostAuthor(
        id=int(data.get("id") or 0),
        fullname=str(data.get("fullname") or ""),
        profile_url=str(urls.get("profile") or ""),
        profile_image_url=str(urls.get("profileimage") or ""),
    )


def parse_forum_post(data: dict) -> ForumPost:
    urls = data.get("urls", {}) if isinstance(data.get("urls"), dict) else {}
    message_html = str(data.get("message") or "")
    message_text, image_urls, links, tables = html_to_structured_content(
        message_html,
        str(urls.get("view") or urls.get("discuss") or ""),
    )
    return ForumPost(
        id=int(data.get("id") or 0),
        discussion_id=int(data.get("discussionid") or 0),
        subject=str(data.get("subject") or ""),
        message_html=message_html,
        message_text=message_text,
        image_urls=image_urls,
        links=links,
        tables=tables,
        author=parse_forum_post_author(data.get("author", {}) if isinstance(data.get("author"), dict) else {}),
        parent_id=int(data.get("parentid") or 0),
        time_created=int(data.get("timecreated") or 0),
        time_modified=int(data.get("timemodified") or 0),
        created_pretty="",
        unread=bool(data.get("unread", False)),
        is_deleted=bool(data.get("isdeleted", False)),
        is_private_reply=bool(data.get("isprivatereply", False)),
        url=str(urls.get("view") or urls.get("viewisolated") or ""),
        reply_url=str(urls.get("reply") or ""),
    )


def parse_forum_discussion(data: dict, discussion_id: int) -> ForumDiscussion:
    posts_raw = data.get("posts", []) if isinstance(data.get("posts"), list) else []
    posts = [parse_forum_post(item) for item in posts_raw if isinstance(item, dict)]

    subject = posts[0].subject if posts else ""
    url = ""
    if posts and posts[0].url:
        url = posts[0].url.split("#", 1)[0]

    return ForumDiscussion(
        id=discussion_id,
        subject=subject,
        course_id=int(data.get("courseid") or 0),
        forum_id=int(data.get("forumid") or 0),
        group_id=int(data.get("groupid") or 0),
        group_name=str(data.get("groupname") or ""),
        url=url,
        posts=posts,
    )
