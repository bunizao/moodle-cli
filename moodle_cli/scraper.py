"""HTML scraping helpers for authenticated Moodle pages."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from html import unescape
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from moodle_cli.exceptions import AuthError
from moodle_cli.models import Activity, Section, UserInfo


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


def _clean_text_from_node(node) -> str:
    if node is None:
        return ""
    return _clean_text(node.get_text(" ", strip=True))


def _clean_text(value: str) -> str:
    return " ".join(unescape(value or "").split())
