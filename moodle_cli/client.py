"""Moodle client using authenticated page scraping and AJAX fallbacks."""

import logging
import time

import requests

from moodle_cli.constants import (
    AJAX_SERVICE_PATH,
    COURSE_PATH,
    DASHBOARD_PATH,
    FUNC_GET_ACTION_EVENTS,
    FUNC_GET_COURSES,
    FUNC_GET_COURSES_BY_TIMELINE,
    FUNC_GET_COURSE_CONTENTS,
    FUNC_GET_SITE_INFO,
    GRADE_REPORT_INDEX_PATH,
    GRADE_REPORT_OVERVIEW_PATH,
    GRADE_REPORT_PATH,
)
from moodle_cli.exceptions import AuthError, MoodleAPIError, MoodleRequestError
from moodle_cli.models import Course, CourseGrades, Section, TodoItem, UserInfo
from moodle_cli.parser import parse_courses, parse_todo_items, parse_user_info
from moodle_cli.scraper import (
    has_course_grades_html,
    parse_course_contents_html,
    parse_course_grades_html,
    parse_course_grades_url,
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
