"""Moodle client using authenticated page scraping and AJAX fallbacks."""

import logging
import re
import time

import requests

from moodle_cli.constants import (
    AJAX_SERVICE_PATH,
    COURSE_PATH,
    DASHBOARD_PATH,
    FUNC_GET_ACTION_EVENTS,
    FUNC_GET_CONVERSATION_COUNTS,
    FUNC_GET_COURSES,
    FUNC_GET_COURSES_BY_TIMELINE,
    FUNC_GET_COURSE_CONTENTS,
    FUNC_GET_DISCUSSION_POSTS,
    FUNC_GET_POPUP_NOTIFICATIONS,
    FUNC_GET_SITE_INFO,
    FUNC_GET_UNREAD_CONVERSATION_COUNTS,
    FORUM_DISCUSS_PATH,
    FORUM_VIEW_PATH,
    GRADE_REPORT_INDEX_PATH,
    GRADE_REPORT_OVERVIEW_PATH,
    GRADE_REPORT_PATH,
)
from moodle_cli.exceptions import AuthError, MoodleAPIError, MoodleRequestError
from moodle_cli.models import (
    AlertSummary,
    Course,
    CourseGrades,
    ForumActivityRef,
    ForumDiscussion,
    ForumDiscussionRef,
    ForumSearchHit,
    Overview,
    Section,
    TodoItem,
    UserInfo,
)
from moodle_cli.parser import parse_alert_summary, parse_courses, parse_forum_discussion, parse_todo_items, parse_user_info
from moodle_cli.scraper import (
    has_course_grades_html,
    parse_course_contents_html,
    parse_course_grades_html,
    parse_course_grades_url,
    parse_forum_discussion_html,
    parse_forum_discussion_group_html,
    parse_forum_discussion_refs_html,
    parse_forum_groups_html,
    parse_forum_group_ids_html,
    parse_forum_view_cmid_from_discussion_html,
    parse_grade_overview_rows,
    parse_course_section_numbers,
    parse_page_context,
)

log = logging.getLogger(__name__)


class MoodleClient:
    """Client for Moodle's authenticated pages and internal AJAX API."""

    def __init__(self, base_url: str, moodle_session: str):
        self.base_url = base_url
        self.session = requests.Session()
        self.session.cookies.set("MoodleSession", moodle_session)

        self._sesskey: str | None = None
        self._userid: int | None = None
        self._user_info: UserInfo | None = None
        self._forum_discussions_cache: dict[int, ForumDiscussion] = {}
        self._forum_discussion_refs_cache: dict[int, list[ForumDiscussionRef]] = {}

    def _ajax_url(self, function_name: str) -> str:
        """Build the AJAX service URL."""
        sesskey = self._sesskey or ""
        return f"{self.base_url}{AJAX_SERVICE_PATH}?sesskey={sesskey}&info={function_name}"

    def _get(self, path: str, params: dict | None = None) -> requests.Response:
        """Fetch an authenticated Moodle page."""
        resp = self.session.get(f"{self.base_url}{path}", params=params)
        resp.raise_for_status()
        return resp

    def _get_absolute(self, url: str) -> requests.Response:
        """Fetch an authenticated Moodle page by absolute URL."""
        resp = self.session.get(url)
        resp.raise_for_status()
        return resp

    def _call(self, function_name: str, args: dict | None = None) -> dict | list:
        """Make a single AJAX service call.

        Returns the 'data' field from the first response item.
        """
        payload = [
            {
                "index": 0,
                "methodname": function_name,
                "args": args or {},
            }
        ]

        url = self._ajax_url(function_name)
        log.debug("POST %s", url)

        resp = self.session.post(url, json=payload)
        resp.raise_for_status()

        result = resp.json()

        # Moodle returns a JSON array
        if isinstance(result, list) and len(result) > 0:
            item = result[0]
            if item.get("error"):
                exc = item.get("exception", {})
                raise MoodleAPIError(
                    exc.get("message", "Unknown API error"),
                    error_code=exc.get("errorcode"),
                )
            return item.get("data", item)

        # Some endpoints return a dict with error info
        if isinstance(result, dict) and result.get("error"):
            raise MoodleAPIError(
                result.get("message", "Unknown error"),
                error_code=result.get("errorcode"),
            )

        return result

    def _ensure_session(self) -> None:
        """Ensure we have an authenticated Moodle context."""
        if self._sesskey and self._userid:
            return
        response = self._get(DASHBOARD_PATH)
        context = parse_page_context(response.text, self.base_url)
        self._sesskey = context.sesskey
        self._userid = context.user_info.userid
        self._user_info = context.user_info

    def get_site_info(self) -> UserInfo:
        """Load authenticated user info, falling back to page scraping when needed."""
        self._ensure_session()

        try:
            data = self._call(FUNC_GET_SITE_INFO)
        except MoodleAPIError as exc:
            if exc.error_code != "servicenotavailable":
                raise
            log.debug("Falling back to scraped user info because %s is unavailable", FUNC_GET_SITE_INFO)
        else:
            if not isinstance(data, dict) or "userid" not in data:
                raise AuthError("Session appears invalid — could not retrieve user info")

            self._sesskey = data.get("sesskey") or self._sesskey
            self._userid = data["userid"]
            self._user_info = parse_user_info(data)

        if self._user_info is None or self._userid is None:
            raise AuthError("Session appears invalid — could not retrieve user info")

        log.debug("Authenticated as %s (uid=%d)", self._user_info.fullname, self._userid)
        return self._user_info

    def get_courses(self) -> list[Course]:
        """Get all enrolled courses for the authenticated user."""
        self._ensure_session()

        try:
            return self._get_courses_timeline()
        except MoodleAPIError as exc:
            if exc.error_code != "servicenotavailable":
                raise
            log.debug("Falling back to %s because timeline API is unavailable", FUNC_GET_COURSES)

        data = self._call(FUNC_GET_COURSES, {"userid": self._userid})
        if not isinstance(data, list):
            return []
        return parse_courses(data)

    def get_course_contents(self, course_id: int) -> list[Section]:
        """Get sections and activities for a course."""
        self._ensure_session()

        try:
            data = self._call(FUNC_GET_COURSE_CONTENTS, {"courseid": course_id})
        except MoodleAPIError as exc:
            if exc.error_code != "servicenotavailable":
                raise
            log.debug("Falling back to scraping %s because %s is unavailable", COURSE_PATH, FUNC_GET_COURSE_CONTENTS)
        else:
            if isinstance(data, list):
                from moodle_cli.parser import parse_course_contents

                return parse_course_contents(data)
            return []

        response = self._get(COURSE_PATH, {"id": course_id})
        sections = self._scrape_course_contents(course_id, response.text)
        return sections

    def get_todo(self, limit: int = 20, days: int | None = None) -> list[TodoItem]:
        """Get upcoming action events from the Moodle timeline."""
        self._ensure_session()

        now = int(time.time())
        timesort_to = now + days * 24 * 60 * 60 if days is not None else 0
        data = self._call(
            FUNC_GET_ACTION_EVENTS,
            {
                "limitnum": limit,
                "timesortfrom": now,
                "timesortto": timesort_to,
                "aftereventid": 0,
                "limittononsuspendedevents": True,
            },
        )
        if not isinstance(data, dict):
            return []

        events = data.get("events", [])
        if not isinstance(events, list):
            return []

        return parse_todo_items(events)

    def get_alerts(self, limit: int = 20) -> AlertSummary:
        """Get notifications and message counts for the authenticated user."""
        self._ensure_session()

        notifications_data = self._call(
            FUNC_GET_POPUP_NOTIFICATIONS,
            {"useridto": self._userid, "limit": limit, "offset": 0},
        )
        counts_data = self._call(FUNC_GET_CONVERSATION_COUNTS, {"userid": self._userid})
        unread_counts_data = self._call(FUNC_GET_UNREAD_CONVERSATION_COUNTS, {"userid": self._userid})

        if not isinstance(notifications_data, dict):
            notifications_data = {}
        if not isinstance(counts_data, dict):
            counts_data = {}
        if not isinstance(unread_counts_data, dict):
            unread_counts_data = {}

        return parse_alert_summary(notifications_data, counts_data, unread_counts_data)

    def get_overview(self, todo_limit: int = 5, todo_days: int | None = None, alerts_limit: int = 5) -> Overview:
        """Get a compact best-effort overview for agent workflows."""
        user = self.get_site_info()
        overview = Overview(user=user)

        for label, loader in [
            ("courses", lambda: self.get_courses()),
            ("todo", lambda: self.get_todo(limit=todo_limit, days=todo_days)),
            ("alerts", lambda: self.get_alerts(limit=alerts_limit)),
        ]:
            try:
                value = loader()
            except (MoodleAPIError, MoodleRequestError) as exc:
                overview.errors.append(f"{label}: {exc}")
                continue

            if label == "courses":
                overview.courses = value
            elif label == "todo":
                overview.todo = value
            elif label == "alerts":
                overview.alerts = value

        return overview

    def get_course_grades(self, course_id: int) -> CourseGrades:
        """Get the authenticated user's grade report for a course."""
        self._ensure_session()
        try:
            course_response = self._get(COURSE_PATH, {"id": course_id})
        except requests.RequestException as exc:
            raise MoodleRequestError(f"Could not load course {course_id}: {exc}") from exc

        candidate_urls = [
            parse_course_grades_url(course_response.text, self.base_url),
            f"{self.base_url}/course/user.php?mode=grade&id={course_id}&user={self._userid}",
            f"{self.base_url}{GRADE_REPORT_OVERVIEW_PATH}",
            f"{self.base_url}{GRADE_REPORT_INDEX_PATH}?id={course_id}",
            f"{self.base_url}{GRADE_REPORT_PATH}?id={course_id}",
        ]
        seen_urls: set[str] = set()
        overview_rows: dict[int, dict[str, str]] = {}

        for url in candidate_urls:
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            try:
                response = self._get_absolute(url)
            except requests.HTTPError as exc:
                status_code = exc.response.status_code if exc.response is not None else None
                if status_code == 404:
                    continue
                raise MoodleRequestError(f"Could not load grades for course {course_id}: {exc}") from exc
            except requests.RequestException as exc:
                raise MoodleRequestError(f"Could not load grades for course {course_id}: {exc}") from exc

            if has_course_grades_html(response.text):
                return parse_course_grades_html(response.text, course_id, self.base_url)

            overview_rows = parse_grade_overview_rows(response.text, self.base_url)
            if overview_rows:
                entry = overview_rows.get(course_id)
                if entry is not None:
                    overview_url = entry.get("url", "")
                    if overview_url and overview_url not in seen_urls:
                        candidate_urls.append(overview_url)
                        continue

                    return CourseGrades(
                        course_id=course_id,
                        course_name=entry.get("course_name", ""),
                        total_grade=entry.get("grade", ""),
                    )

        if overview_rows and course_id not in overview_rows:
            raise MoodleRequestError(
                f"Grades are not listed for course {course_id} in this site's overview report. "
                "The course may not expose grades to students."
            )

        raise MoodleRequestError(
            f"Could not find a usable grades page for course {course_id}. "
            "This Moodle site may use a different grade report configuration."
        )

    def get_forum_discussion(self, discussion_id: int) -> ForumDiscussion:
        """Get posts in a forum discussion, using AJAX when available."""
        cached = self._forum_discussions_cache.get(discussion_id)
        if cached is not None:
            return cached

        self._ensure_session()

        try:
            data = self._call(
                FUNC_GET_DISCUSSION_POSTS,
                {"discussionid": discussion_id, "sortby": "created", "sortdirection": "ASC", "includeinlineattachments": True},
            )
        except MoodleAPIError as exc:
            should_fallback = exc.error_code in {"servicenotavailable", "accessexception"} or "Web service is not available" in str(exc)
            if not should_fallback:
                raise
            log.debug("Falling back to scraping %s because %s is unavailable (%s)", FORUM_DISCUSS_PATH, FUNC_GET_DISCUSSION_POSTS, exc)
        else:
            if isinstance(data, dict):
                discussion = parse_forum_discussion(data, discussion_id)
                if discussion.group_id <= 0:
                    try:
                        response = self._get(FORUM_DISCUSS_PATH, {"d": discussion_id})
                    except requests.RequestException:
                        response = None
                    if response is not None:
                        discussion.group_id, discussion.group_name = parse_forum_discussion_group_html(response.text)
                self._forum_discussions_cache[discussion_id] = discussion
                return discussion

        try:
            response = self._get(FORUM_DISCUSS_PATH, {"d": discussion_id})
        except requests.RequestException as exc:
            raise MoodleRequestError(f"Could not load forum discussion {discussion_id}: {exc}") from exc

        discussion = parse_forum_discussion_html(response.text, self.base_url, discussion_id)
        self._forum_discussions_cache[discussion_id] = discussion
        return discussion

    def get_forum_view_cmid(self, discussion_id: int) -> int | None:
        """Resolve the forum view course-module ID for a discussion."""
        self._ensure_session()
        try:
            response = self._get(FORUM_DISCUSS_PATH, {"d": discussion_id})
        except requests.RequestException as exc:
            raise MoodleRequestError(f"Could not load forum discussion {discussion_id}: {exc}") from exc
        return parse_forum_view_cmid_from_discussion_html(response.text)

    def get_forum_discussion_refs(self, forum_cmid: int) -> list[ForumDiscussionRef]:
        """List discussions from a forum view page."""
        cached = self._forum_discussion_refs_cache.get(forum_cmid)
        if cached is not None:
            return cached

        self._ensure_session()
        try:
            response = self._get(FORUM_VIEW_PATH, {"id": forum_cmid})
        except requests.RequestException as exc:
            raise MoodleRequestError(f"Could not load forum {forum_cmid}: {exc}") from exc

        groups = parse_forum_groups_html(response.text)
        refs = parse_forum_discussion_refs_html(response.text, self.base_url) if not groups else []
        seen_ids = {ref.id for ref in refs}

        for group_id, group_name in groups:
            try:
                group_response = self._get(FORUM_VIEW_PATH, {"id": forum_cmid, "group": group_id})
            except requests.RequestException as exc:
                raise MoodleRequestError(f"Could not load forum {forum_cmid} group {group_id}: {exc}") from exc

            for ref in parse_forum_discussion_refs_html(group_response.text, self.base_url):
                if ref.id in seen_ids:
                    continue
                seen_ids.add(ref.id)
                ref.group_id = group_id
                ref.group_name = group_name
                refs.append(ref)

        self._forum_discussion_refs_cache[forum_cmid] = refs
        return refs

    def get_course_forums(self, course_id: int, course_name: str = "") -> list[ForumActivityRef]:
        """List forum activities in a course."""
        sections = self.get_course_contents(course_id)
        return [
            ForumActivityRef(
                id=activity.id,
                name=activity.name,
                course_id=course_id,
                course_name=course_name,
                url=activity.url,
            )
            for section in sections
            for activity in section.activities
            if activity.modname == "forum"
        ]

    def get_forums(self, course_id: int | None = None) -> list[ForumActivityRef]:
        """List forum activities across one course or all enrolled courses."""
        if course_id is not None:
            course_name = ""
            for course in self.get_courses():
                if course.id == course_id:
                    course_name = course.fullname or course.shortname
                    break
            return self.get_course_forums(course_id, course_name=course_name)

        refs: list[ForumActivityRef] = []
        for course in self.get_courses():
            refs.extend(self.get_course_forums(course.id, course_name=course.fullname or course.shortname))
        return refs

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
        """Search forum discussion titles and optionally post content."""
        query = query.strip()
        if not query:
            return []

        forum_refs = self.get_forums(course_id=course_id)
        if forum_cmid is not None:
            forum_refs = [ref for ref in forum_refs if ref.id == forum_cmid]
            if not forum_refs:
                forum_refs = [ForumActivityRef(id=forum_cmid, url=f"{self.base_url}{FORUM_VIEW_PATH}?id={forum_cmid}")]
        elif max_forums is not None:
            forum_refs = forum_refs[:max_forums]

        hits: list[tuple[int, ForumSearchHit]] = []
        seen: set[tuple[int, int]] = set()

        for forum_ref in forum_refs:
            refs = self.get_forum_discussion_refs(forum_ref.id)
            if max_discussions_per_forum is not None:
                refs = refs[:max_discussions_per_forum]
            for ref in refs:
                discussion: ForumDiscussion | None = None
                latest_post = None
                discussion_has_unread = False
                matching_post_hits: list[tuple[int, ForumSearchHit]] = []

                if include_post_text or unread_only or sort_by == "recent":
                    discussion = self.get_forum_discussion(ref.id)
                    if discussion.posts:
                        latest_post = max(discussion.posts, key=lambda post: post.time_created or 0)
                        discussion_has_unread = any(post.unread for post in discussion.posts)

                if not include_post_text:
                    subject_score = _match_score(ref.subject, query)
                    if subject_score > 0 and (not unread_only or discussion_has_unread):
                        key = (ref.id, 0)
                        if key not in seen:
                            seen.add(key)
                            hits.append(
                                (
                                    400 + subject_score,
                                    ForumSearchHit(
                                        course_id=forum_ref.course_id,
                                        course_name=forum_ref.course_name,
                                        forum_id=forum_ref.id,
                                        forum_name=forum_ref.name,
                                        group_id=ref.group_id,
                                        group_name=ref.group_name,
                                        discussion_id=ref.id,
                                        discussion_subject=ref.subject,
                                        matched_in="discussion_subject",
                                        snippet=_snippet_for_text(ref.subject, query),
                                        unread=discussion_has_unread,
                                        time_created=latest_post.time_created if latest_post is not None else 0,
                                        url=ref.url,
                                    ),
                                )
                            )
                    continue

                if discussion is None:
                    discussion = self.get_forum_discussion(ref.id)
                for post in discussion.posts:
                    post_subject_score = _match_score(post.subject, query)
                    post_body_score = _match_score(post.message_text, query)
                    if post_subject_score <= 0 and post_body_score <= 0:
                        continue
                    if unread_only and not post.unread:
                        continue

                    matched_in = "post_subject" if post_subject_score >= post_body_score else "post_body"
                    matched_text = post.subject if matched_in == "post_subject" else post.message_text
                    score = 300 + max(post_subject_score, post_body_score)
                    key = (ref.id, post.id)
                    if key in seen:
                        continue
                    matching_post_hits.append(
                        (
                            score,
                            ForumSearchHit(
                                course_id=forum_ref.course_id,
                                course_name=forum_ref.course_name,
                                forum_id=forum_ref.id,
                                forum_name=forum_ref.name,
                                group_id=discussion.group_id or ref.group_id,
                                group_name=discussion.group_name or ref.group_name,
                                discussion_id=ref.id,
                                discussion_subject=discussion.subject or ref.subject,
                                post_id=post.id,
                                author_name=post.author.fullname,
                                matched_in=matched_in,
                                snippet=_snippet_for_text(matched_text, query),
                                unread=post.unread,
                                time_created=post.time_created,
                                url=post.url or ref.url,
                            ),
                        )
                    )

                if matching_post_hits:
                    for score, hit in matching_post_hits:
                        key = (hit.discussion_id, hit.post_id)
                        if key in seen:
                            continue
                        seen.add(key)
                        hits.append((score, hit))
                    continue

                subject_score = _match_score(ref.subject, query)
                if subject_score > 0 and (not unread_only or discussion_has_unread):
                    key = (ref.id, 0)
                    if key not in seen:
                        seen.add(key)
                        hits.append(
                            (
                                400 + subject_score,
                                ForumSearchHit(
                                    course_id=forum_ref.course_id,
                                    course_name=forum_ref.course_name,
                                    forum_id=forum_ref.id,
                                    forum_name=forum_ref.name,
                                    discussion_id=ref.id,
                                    discussion_subject=ref.subject,
                                    matched_in="discussion_subject",
                                    snippet=_snippet_for_text(ref.subject, query),
                                    unread=discussion_has_unread,
                                    time_created=latest_post.time_created if latest_post is not None else 0,
                                    url=ref.url,
                                ),
                            )
                        )

        if sort_by == "recent":
            hits.sort(
                key=lambda item: (
                    -(item[1].time_created or 0),
                    -item[0],
                    item[1].course_name.lower(),
                    item[1].forum_name.lower(),
                    item[1].discussion_id,
                    item[1].post_id,
                )
            )
        else:
            hits.sort(
                key=lambda item: (
                    -item[0],
                    item[1].course_name.lower(),
                    item[1].forum_name.lower(),
                    item[1].discussion_id,
                    item[1].post_id,
                )
            )
        return [hit for _, hit in hits[:limit]]

    def _get_courses_timeline(self) -> list[Course]:
        """Get enrolled courses from the dashboard timeline API."""
        courses: list[dict] = []
        offset = 0

        while True:
            data = self._call(
                FUNC_GET_COURSES_BY_TIMELINE,
                {"classification": "all", "limit": 100, "offset": offset},
            )
            if not isinstance(data, dict):
                break

            batch = data.get("courses", [])
            if not isinstance(batch, list) or not batch:
                break

            courses.extend(batch)

            next_offset = data.get("nextoffset", offset)
            if not isinstance(next_offset, int) or next_offset <= offset:
                break
            offset = next_offset

        return parse_courses(courses)

    def _scrape_course_contents(self, course_id: int, root_html: str) -> list[Section]:
        """Aggregate sections from section-specific course pages."""
        section_numbers = parse_course_section_numbers(root_html, course_id)
        html_pages = [root_html]

        for section_num in section_numbers:
            if section_num == 0:
                continue
            response = self._get(COURSE_PATH, {"id": course_id, "section": section_num})
            html_pages.append(response.text)

        sections: list[Section] = []
        seen_sections: set[int] = set()
        for html in html_pages:
            for section in parse_course_contents_html(html, self.base_url):
                section_key = section.section or section.id
                if section_key in seen_sections:
                    continue
                seen_sections.add(section_key)
                sections.append(section)

        return sections


def _normalize_query(value: str) -> tuple[str, list[str]]:
    cleaned = " ".join((value or "").lower().split())
    tokens = [token for token in re.split(r"\s+", cleaned) if token]
    return cleaned, tokens


def _match_score(text: str, query: str) -> int:
    haystack = " ".join((text or "").lower().split())
    if not haystack:
        return 0

    normalized_query, tokens = _normalize_query(query)
    if not normalized_query:
        return 0
    if normalized_query in haystack:
        return 100 + len(normalized_query)
    if tokens and all(token in haystack for token in tokens):
        return 60 + len(tokens)
    return 0


def _snippet_for_text(text: str, query: str, max_len: int = 120) -> str:
    cleaned = " ".join((text or "").split())
    if not cleaned:
        return ""

    normalized_query, tokens = _normalize_query(query)
    lower = cleaned.lower()
    start = lower.find(normalized_query) if normalized_query else -1
    if start < 0:
        for token in tokens:
            start = lower.find(token)
            if start >= 0:
                break

    if start < 0 or len(cleaned) <= max_len:
        return cleaned if len(cleaned) <= max_len else f"{cleaned[: max_len - 1]}…"

    half = max_len // 2
    left = max(0, start - half)
    right = min(len(cleaned), left + max_len)
    snippet = cleaned[left:right]
    if left > 0:
        snippet = f"…{snippet}"
    if right < len(cleaned):
        snippet = f"{snippet}…"
    return snippet
