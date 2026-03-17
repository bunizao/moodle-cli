"""HTML scraping helpers for authenticated Moodle pages."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from html import unescape
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup

from moodle_cli.exceptions import AuthError
from moodle_cli.html_utils import html_to_text_and_image_urls
from moodle_cli.models import (
    Activity,
    Assignment,
    CourseGrades,
    ForumDiscussion,
    ForumDiscussionRef,
    ForumPost,
    ForumPostAuthor,
    GradeItem,
    Section,
    UserInfo,
)


@dataclass
class PageContext:
    """Minimal authenticated context extracted from a Moodle page."""

    sesskey: str
    user_info: UserInfo


def parse_page_context(html: str, base_url: str) -> PageContext:
    """Extract sesskey and user identity from an authenticated page."""
    config = _parse_moodle_config(html)
    soup = BeautifulSoup(html, "html.parser")

    sesskey = str(config.get("sesskey") or "").strip()
    user_id = int(config.get("userId") or _search_int(html, r'data-user-id="(\d+)"'))
    fullname = _clean_text_from_node(soup.select_one(".userfullname"))
    sitename = _extract_sitename(soup)
    fallback_lang = soup.html.get("lang", "") if soup.html else ""
    lang = str(config.get("language") or fallback_lang)

    if not sesskey or not user_id:
        raise AuthError("Session appears invalid — could not load authenticated Moodle context")

    return PageContext(
        sesskey=sesskey,
        user_info=UserInfo(
            userid=user_id,
            username="",
            fullname=fullname,
            sitename=sitename,
            siteurl=base_url,
            lang=lang,
        ),
    )


def parse_forum_discussion_html(html: str, base_url: str, discussion_id: int) -> ForumDiscussion:
    """Parse a rendered Moodle forum discussion page into posts."""
    soup = BeautifulSoup(html, "html.parser")
    post_els = soup.select("div.forumpost[data-post-id]")
    if not post_els:
        post_els = soup.select("article[data-post-id]")

    posts: list[ForumPost] = []
    for el in post_els:
        post_id = _safe_int(el.get("data-post-id"))
        if not post_id:
            continue

        header = el.select_one("header") or el.select_one(".header")
        subject = _clean_text_from_node(
            (header.select_one("h3") if header is not None else None)
            or el.select_one("h3")
            or el.select_one("[data-region='post-title']")
        )

        author_link = (
            (header.select_one('a[href*="/user/"]') if header is not None else None)
            or el.select_one('a[href*="/user/"]')
            or el.select_one('a[href*="/user/profile.php"]')
        )
        author_name = _clean_text(author_link.get_text(" ", strip=True) if author_link is not None else "")
        author_url = urljoin(base_url, author_link.get("href") or "") if author_link is not None else ""

        date_el = (header.select_one(".date") if header is not None else None) or (header.select_one("time") if header else None)
        created_pretty = _clean_text_from_node(date_el) if date_el is not None else ""

        message_el = (
            el.select_one(".post-content-container")
            or el.select_one(".content")
            or el.select_one("[data-region='post-content']")
            or el.select_one("[data-region-content='forum-post-core']")
        )
        message_html = message_el.decode_contents() if message_el is not None else ""
        message_text, image_urls = html_to_text_and_image_urls(message_html, base_url)

        posts.append(
            ForumPost(
                id=post_id,
                discussion_id=discussion_id,
                subject=subject,
                message_html=message_html,
                message_text=message_text,
                image_urls=image_urls,
                author=ForumPostAuthor(id=0, fullname=author_name, profile_url=author_url),
                created_pretty=created_pretty,
                url=f"{base_url.rstrip('/')}/mod/forum/discuss.php?d={discussion_id}#p{post_id}",
                reply_url=f"{base_url.rstrip('/')}/mod/forum/post.php?reply={post_id}#mformforum",
            )
        )

    subject = posts[0].subject if posts else ""
    url = f"{base_url.rstrip('/')}/mod/forum/discuss.php?d={discussion_id}"
    return ForumDiscussion(id=discussion_id, subject=subject, url=url, posts=posts)


def parse_forum_view_cmid_from_discussion_html(html: str) -> int | None:
    """Extract the forum view course-module ID from a discussion page."""
    soup = BeautifulSoup(html, "html.parser")
    link = soup.select_one('a[href*="/mod/forum/view.php?id="], a[href*="mod/forum/view.php?id="]')
    if link is None:
        return None

    href = link.get("href") or ""
    parsed = urlparse(href)
    if "/mod/forum/view.php" not in parsed.path:
        return None
    query = parse_qs(parsed.query)
    values = query.get("id") or []
    if not values or not values[0].isdigit():
        return None
    return int(values[0])


def parse_forum_discussion_refs_html(html: str, base_url: str) -> list[ForumDiscussionRef]:
    """Extract discussion IDs and subjects from a forum view page."""
    soup = BeautifulSoup(html, "html.parser")
    refs: list[ForumDiscussionRef] = []
    seen: set[int] = set()

    for link in soup.select('a[href*="/mod/forum/discuss.php?d="], a[href*="mod/forum/discuss.php?d="], a[href*="discuss.php?d="]'):
        href = link.get("href") or ""
        parsed = urlparse(href)
        if "/mod/forum/discuss.php" not in parsed.path:
            continue
        query = parse_qs(parsed.query)
        values = query.get("d") or []
        if not values or not values[0].isdigit():
            continue

        discussion_id = int(values[0])
        if discussion_id in seen:
            continue

        subject = _clean_text_from_node(link)
        if not subject or subject.lower() in {"permalink", "discuss"}:
            continue

        seen.add(discussion_id)
        refs.append(
            ForumDiscussionRef(
                id=discussion_id,
                subject=subject,
                url=urljoin(base_url, href),
            )
        )

    return refs


def parse_course_contents_html(html: str, base_url: str) -> list[Section]:
    """Parse rendered Moodle course HTML into sections and activities."""
    soup = BeautifulSoup(html, "html.parser")
    sections: list[Section] = []

    for section_el in soup.select('li[data-for="section"]'):
        section_id = _safe_int(section_el.get("data-id"))
        section_num = _safe_int(section_el.get("data-number") or section_el.get("data-sectionnum"))
        position_name = _clean_text_from_node(section_el.select_one(".course-section-position-name"))
        main_name = _clean_text_from_node(
            section_el.select_one("h1.sectionname, h2.sectionname, h3.sectionname")
            or section_el.select_one('[data-for="section_title"] a')
            or section_el.select_one('[data-for="section_title"]')
        )
        if position_name and main_name and position_name != main_name:
            section_name = f"{position_name} - {main_name}"
        else:
            section_name = main_name or position_name or f"Section {section_num}"

        summary_el = section_el.select_one(".summarytext, [data-for='sectioninfo']")
        summary = _clean_text_from_node(summary_el)
        section_visible = "hidden" not in section_el.get("class", [])

        activities: list[Activity] = []
        seen_activity_ids: set[int] = set()
        for activity_el in section_el.select('li[data-for="cmitem"]'):
            activity_id = _safe_int(activity_el.get("data-id"))
            if activity_id and activity_id in seen_activity_ids:
                continue
            if activity_id:
                seen_activity_ids.add(activity_id)

            classes = activity_el.get("class", [])
            modname = next((cls[8:] for cls in classes if cls.startswith("modtype_")), "")
            card = activity_el.select_one('[data-region="activity-card"]') or activity_el.select_one(".activity-item")

            activity_name = _clean_text_from_node(
                activity_el.select_one(".activityname .instancename")
                or activity_el.select_one(".activityname")
                or activity_el.select_one("a.aalink")
            )
            if not activity_name and card is not None:
                activity_name = (card.get("data-activityname") or "").strip()
            if not activity_name:
                continue

            link = activity_el.select_one(".activityname a, a.aalink, a[href]")
            href = link.get("href") if link else ""
            description = _clean_text_from_node(
                activity_el.select_one("[data-region='activity-description'], .contentafterlink, .description")
            )
            activity_visible = not any(flag in classes for flag in ("hidden", "stealth", "dimmed"))

            activities.append(
                Activity(
                    id=activity_id,
                    name=activity_name,
                    modname=modname,
                    url=urljoin(base_url, href) if href else "",
                    visible=activity_visible,
                    description=description,
                )
            )

        sections.append(
            Section(
                id=section_id,
                name=section_name,
                section=section_num,
                visible=section_visible,
                summary=summary,
                activities=activities,
            )
        )

    return sections


def parse_course_section_numbers(html: str, course_id: int) -> list[int]:
    """Extract the ordered section numbers exposed by the course navigation."""
    soup = BeautifulSoup(html, "html.parser")
    section_numbers: list[int] = []

    for link in soup.select(f'a[href*="/course/view.php?id={course_id}&section="]'):
        href = link.get("href") or ""
        match = re.search(r"[?&]section=(\d+)", href)
        if not match:
            continue

        section_num = int(match.group(1))
        if section_num not in section_numbers:
            section_numbers.append(section_num)

    return section_numbers


def parse_course_grades_html(html: str, course_id: int, base_url: str) -> CourseGrades:
    """Parse the per-course Moodle user grade report."""
    soup = BeautifulSoup(html, "html.parser")
    course_name = _clean_text_from_node(soup.select_one("h1"))
    learner_name = _clean_text_from_node(
        soup.select_one(".grade-report-user .page-header-headings h2")
        or soup.select_one(".page-header-image + .page-header-headings h2")
        or soup.select_one(".page-header-headings h2")
        or soup.select_one(".grade-report-user h2 a, .grade-report-user h2")
        or soup.select_one('h2 a[href*="/user/view.php?id="], h2 a[href*="/user/profile.php?id="]')
        or soup.select_one("h2 a")
    )
    report = CourseGrades(course_id=course_id, course_name=course_name, learner_name=learner_name)

    table = soup.select_one("table.user-grade")
    if table is None:
        return report

    for row in table.select("tr"):
        title = _clean_text_from_node(row.select_one(".rowtitle"))
        if not title:
            continue

        if row.select_one(".toggle-category") is not None:
            continue

        if title == "Course total":
            report.total_grade = _clean_table_cell(row.select_one("td.column-grade"))
            report.total_range = _clean_table_cell(row.select_one("td.column-range"))
            report.total_percentage = _clean_table_cell(row.select_one("td.column-percentage"))
            continue

        link = row.select_one(".rowtitle a.gradeitemheader, .rowtitle a")
        if link is None:
            continue

        status = ""
        status_icon = row.select_one("td.column-grade i[aria-label], td.column-grade i[title]")
        if status_icon is not None:
            status = (status_icon.get("aria-label") or status_icon.get("title") or "").strip()

        item_type = (
            _clean_text(row.select_one(".item img.itemicon, .courseitem img.itemicon").get("alt", ""))
            if row.select_one(".item img.itemicon, .courseitem img.itemicon") is not None
            else ""
        )
        report.items.append(
            GradeItem(
                name=title,
                item_type=item_type,
                grade=_clean_table_cell(row.select_one("td.column-grade")),
                range=_clean_table_cell(row.select_one("td.column-range")),
                percentage=_clean_table_cell(row.select_one("td.column-percentage")),
                weight=_clean_table_cell(row.select_one("td.column-weight")),
                contribution=_clean_table_cell(row.select_one("td.column-contributiontocoursetotal")),
                feedback=_clean_table_cell(row.select_one("td.column-feedback")),
                url=urljoin(base_url, link.get("href") or ""),
                status=status,
            )
        )

    return report


def parse_course_grades_url(html: str, base_url: str) -> str:
    """Extract the course-specific grades URL from course navigation."""
    soup = BeautifulSoup(html, "html.parser")
    link = (
        soup.select_one('li[data-key="grades"] a[href]')
        or soup.select_one('.secondary-navigation a[href*="mode=grade"]')
        or soup.select_one('.secondary-navigation a[href*="/grade/report/"]')
    )
    if link is None:
        return ""
    return urljoin(base_url, link.get("href") or "")


def parse_course_id_from_page_html(html: str) -> int | None:
    """Extract a course ID from a rendered Moodle page."""
    soup = BeautifulSoup(html, "html.parser")
    selectors = [
        'nav[aria-label="Breadcrumb"] a[href*="/course/view.php?id="]',
        '#page-navbar a[href*="/course/view.php?id="]',
        'li[data-key="coursehome"] a[href*="/course/view.php?id="]',
        '.breadcrumb a[href*="/course/view.php?id="]',
        '.page-context-header a[href*="/course/view.php?id="]',
        '.secondary-navigation a[href*="/course/view.php?id="]',
        'a[href*="/course/view.php?id="]',
    ]

    for selector in selectors:
        link = soup.select_one(selector)
        if link is None:
            continue

        course_id = _parse_course_id_from_href(link.get("href") or "")
        if course_id is not None:
            return course_id

    match = re.search(r"/course/view\.php\?[^\"'>]*[?&]id=(\d+)", html)
    if match is None:
        return None
    return int(match.group(1))


def parse_assignment_html(html: str, assignment_id: int, base_url: str) -> Assignment:
    """Parse a rendered assignment page into a compact summary."""
    soup = BeautifulSoup(html, "html.parser")
    assignment = Assignment(
        id=assignment_id,
        name=_clean_text_from_node(soup.select_one("h1")),
        course_id=parse_course_id_from_page_html(html) or 0,
        url=f"{base_url.rstrip('/')}/mod/assign/view.php?id={assignment_id}",
    )

    breadcrumb_links = soup.select('nav[aria-label="Breadcrumb"] a[href], #page-navbar .breadcrumb a[href]')
    for link in breadcrumb_links:
        href = link.get("href") or ""
        if not assignment.section_name and "/course/view.php" in href and "section=" in href:
            assignment.section_name = _clean_text_from_node(link)

        course_id = _parse_course_id_from_href(href)
        if course_id is not None:
            assignment.course_id = course_id
            if not assignment.course_name:
                assignment.course_name = (link.get("title") or "").strip() or _clean_text_from_node(link)

    due_label = soup.find(["strong", "b"], string=re.compile(r"^\s*Due:\s*$"))
    if due_label is not None:
        due_parts = []
        for sibling in due_label.next_siblings:
            text = _clean_text_from_node(sibling) if hasattr(sibling, "get_text") else _clean_text(str(sibling))
            if text:
                due_parts.append(text)
        assignment.due_pretty = " ".join(due_parts).strip()

    assignment.submission_status = _find_table_value(soup, "Submission status")
    assignment.grading_status = _find_table_value(soup, "Grading status")
    assignment.time_remaining = _find_table_value(soup, "Time remaining")
    assignment.grade = _find_table_value(soup, "Grade")
    return assignment


def has_course_grades_html(html: str) -> bool:
    """Return whether the HTML contains a Moodle user grade report table."""
    soup = BeautifulSoup(html, "html.parser")
    return soup.select_one("table.user-grade") is not None


def parse_grade_overview_rows(html: str, base_url: str) -> dict[int, dict[str, str]]:
    """Parse the grade overview table keyed by course ID."""
    soup = BeautifulSoup(html, "html.parser")
    rows: dict[int, dict[str, str]] = {}

    for row in soup.select("table#overview-grade tbody tr"):
        link = row.select_one("td a[href]")
        if link is None:
            continue

        href = urljoin(base_url, link.get("href") or "")
        match = re.search(r"[?&]id=(\d+)", href)
        if match is None:
            continue

        course_id = int(match.group(1))
        cells = row.select("td")
        rows[course_id] = {
            "course_name": _clean_text_from_node(link),
            "grade": _clean_text_from_node(cells[1]) if len(cells) > 1 else "",
            "url": href,
        }

    return rows


def _parse_moodle_config(html: str) -> dict:
    match = re.search(r"M\.cfg\s*=\s*({.*?});", html, re.S)
    if not match:
        return {}

    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}


def _extract_sitename(soup: BeautifulSoup) -> str:
    title = _clean_text_from_node(soup.title)
    if "|" in title:
        return title.rsplit("|", 1)[1].strip()
    return title


def _search_int(html: str, pattern: str) -> int:
    match = re.search(pattern, html)
    return int(match.group(1)) if match else 0


def _safe_int(value: str | None) -> int:
    try:
        return int(value or 0)
    except ValueError:
        return 0


def _parse_course_id_from_href(href: str) -> int | None:
    parsed = urlparse(href)
    if "/course/view.php" not in parsed.path:
        return None

    query = parse_qs(parsed.query)
    values = query.get("id") or []
    if not values or not values[0].isdigit():
        return None
    return int(values[0])


def _find_table_value(soup: BeautifulSoup, label: str) -> str:
    for row in soup.select("tr"):
        header = _clean_text_from_node(row.select_one("th, td.cell.c0"))
        if header != label:
            continue

        value_cell = row.select_one("td") or row.select_one("th + td")
        if value_cell is None:
            cells = row.select("td")
            value_cell = cells[-1] if cells else None
        return _clean_table_cell(value_cell)
    return ""


def _clean_text_from_node(node) -> str:
    if node is None:
        return ""
    return _clean_text(node.get_text(" ", strip=True))


def _clean_text(value: str) -> str:
    return " ".join(unescape(value or "").split())


def _clean_table_cell(node) -> str:
    if node is None:
        return ""

    node = BeautifulSoup(str(node), "html.parser")
    for unwanted in node.select(".action-menu, .dropdown, script, style"):
        unwanted.decompose()
    return _clean_text(node.get_text(" ", strip=True).replace("( Empty )", "(Empty)"))
