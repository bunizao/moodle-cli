"""Data models for Moodle entities."""

from dataclasses import dataclass, field
import time


@dataclass
class UserInfo:
    userid: int
    username: str
    fullname: str
    sitename: str
    siteurl: str
    lang: str = ""

    def to_dict(self) -> dict:
        return {
            "userid": self.userid,
            "username": self.username,
            "fullname": self.fullname,
            "sitename": self.sitename,
            "siteurl": self.siteurl,
            "lang": self.lang,
        }


@dataclass
class Course:
    id: int
    shortname: str
    fullname: str
    category: int = 0
    visible: bool = True
    startdate: int = 0
    enddate: int = 0

    def to_dict(self) -> dict:
        data = {
            "id": self.id,
            "shortname": self.shortname,
            "fullname": self.fullname,
            "category": self.category,
            "visible": self.visible,
            "startdate": self.startdate,
        }
        if self.enddate > int(time.time()):
            data["enddate"] = self.enddate
        return data


@dataclass
class Activity:
    id: int
    name: str
    modname: str  # e.g. "assign", "forum", "resource", "url"
    url: str = ""
    visible: bool = True
    description: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "modname": self.modname,
            "url": self.url,
            "visible": self.visible,
            "description": self.description,
        }


@dataclass
class TodoItem:
    id: int
    name: str
    activity_name: str
    modname: str
    course_id: int
    course_name: str
    due_at: int
    overdue: bool = False
    actionable: bool = False
    action_name: str = ""
    action_url: str = ""
    url: str = ""
    event_type: str = ""
    course_progress: int | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "activity_name": self.activity_name,
            "modname": self.modname,
            "course_id": self.course_id,
            "course_name": self.course_name,
            "due_at": self.due_at,
            "overdue": self.overdue,
            "actionable": self.actionable,
            "action_name": self.action_name,
            "action_url": self.action_url,
            "url": self.url,
            "event_type": self.event_type,
            "course_progress": self.course_progress,
        }


@dataclass
class AlertNotification:
    id: int
    subject: str
    short_subject: str
    event_type: str
    component: str
    created_at: int
    created_pretty: str = ""
    read: bool = False
    context_url: str = ""
    context_name: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "subject": self.subject,
            "short_subject": self.short_subject,
            "event_type": self.event_type,
            "component": self.component,
            "created_at": self.created_at,
            "created_pretty": self.created_pretty,
            "read": self.read,
            "context_url": self.context_url,
            "context_name": self.context_name,
        }


@dataclass
class AlertSummary:
    notifications: list[AlertNotification] = field(default_factory=list)
    notification_count: int = 0
    unread_notification_count: int = 0
    starred_message_count: int = 0
    direct_message_count: int = 0
    group_message_count: int = 0
    self_message_count: int = 0
    unread_starred_message_count: int = 0
    unread_direct_message_count: int = 0
    unread_group_message_count: int = 0
    unread_self_message_count: int = 0

    def to_dict(self) -> dict:
        return {
            "notifications": [notification.to_dict() for notification in self.notifications],
            "notification_count": self.notification_count,
            "unread_notification_count": self.unread_notification_count,
            "starred_message_count": self.starred_message_count,
            "direct_message_count": self.direct_message_count,
            "group_message_count": self.group_message_count,
            "self_message_count": self.self_message_count,
            "unread_starred_message_count": self.unread_starred_message_count,
            "unread_direct_message_count": self.unread_direct_message_count,
            "unread_group_message_count": self.unread_group_message_count,
            "unread_self_message_count": self.unread_self_message_count,
        }


@dataclass
class GradeItem:
    name: str
    item_type: str
    grade: str = ""
    range: str = ""
    percentage: str = ""
    weight: str = ""
    contribution: str = ""
    feedback: str = ""
    url: str = ""
    status: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "item_type": self.item_type,
            "grade": self.grade,
            "range": self.range,
            "percentage": self.percentage,
            "weight": self.weight,
            "contribution": self.contribution,
            "feedback": self.feedback,
            "url": self.url,
            "status": self.status,
        }


@dataclass
class CourseGrades:
    course_id: int
    course_name: str
    learner_name: str = ""
    total_grade: str = ""
    total_range: str = ""
    total_percentage: str = ""
    items: list[GradeItem] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "course_id": self.course_id,
            "course_name": self.course_name,
            "learner_name": self.learner_name,
            "total_grade": self.total_grade,
            "total_range": self.total_range,
            "total_percentage": self.total_percentage,
            "items": [item.to_dict() for item in self.items],
        }


@dataclass
class Assignment:
    id: int
    name: str
    course_id: int = 0
    course_name: str = ""
    section_name: str = ""
    due_pretty: str = ""
    submission_status: str = ""
    grading_status: str = ""
    time_remaining: str = ""
    grade: str = ""
    url: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "course_id": self.course_id,
            "course_name": self.course_name,
            "section_name": self.section_name,
            "due_pretty": self.due_pretty,
            "submission_status": self.submission_status,
            "grading_status": self.grading_status,
            "time_remaining": self.time_remaining,
            "grade": self.grade,
            "url": self.url,
        }


@dataclass
class Overview:
    user: UserInfo
    courses: list[Course] = field(default_factory=list)
    todo: list[TodoItem] = field(default_factory=list)
    alerts: AlertSummary | None = None
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "user": self.user.to_dict(),
            "courses": [course.to_dict() for course in self.courses],
            "todo": [item.to_dict() for item in self.todo],
            "alerts": self.alerts.to_dict() if self.alerts is not None else None,
            "errors": self.errors,
        }


@dataclass
class Section:
    id: int
    name: str
    section: int  # position/order number
    visible: bool = True
    summary: str = ""
    activities: list[Activity] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "section": self.section,
            "visible": self.visible,
            "summary": self.summary,
            "activities": [a.to_dict() for a in self.activities],
        }


@dataclass
class ForumPostAuthor:
    id: int
    fullname: str = ""
    profile_url: str = ""
    profile_image_url: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "fullname": self.fullname,
            "profile_url": self.profile_url,
            "profile_image_url": self.profile_image_url,
        }


@dataclass
class ForumPost:
    id: int
    discussion_id: int
    subject: str = ""
    message_html: str = ""
    message_text: str = ""
    image_urls: list[str] = field(default_factory=list)
    author: ForumPostAuthor = field(default_factory=lambda: ForumPostAuthor(id=0))
    parent_id: int = 0
    time_created: int = 0
    time_modified: int = 0
    created_pretty: str = ""
    unread: bool = False
    is_deleted: bool = False
    is_private_reply: bool = False
    url: str = ""
    reply_url: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "discussion_id": self.discussion_id,
            "subject": self.subject,
            "message_html": self.message_html,
            "message_text": self.message_text,
            "image_urls": self.image_urls,
            "author": self.author.to_dict(),
            "parent_id": self.parent_id,
            "time_created": self.time_created,
            "time_modified": self.time_modified,
            "created_pretty": self.created_pretty,
            "unread": self.unread,
            "is_deleted": self.is_deleted,
            "is_private_reply": self.is_private_reply,
            "url": self.url,
            "reply_url": self.reply_url,
        }


@dataclass
class ForumDiscussion:
    id: int
    subject: str = ""
    course_id: int = 0
    forum_id: int = 0
    url: str = ""
    posts: list[ForumPost] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "subject": self.subject,
            "course_id": self.course_id,
            "forum_id": self.forum_id,
            "url": self.url,
            "posts": [post.to_dict() for post in self.posts],
        }


@dataclass
class ForumDiscussionRef:
    id: int
    subject: str = ""
    url: str = ""

    def to_dict(self) -> dict:
        return {"id": self.id, "subject": self.subject, "url": self.url}
