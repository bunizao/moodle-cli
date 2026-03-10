"""Parse raw Moodle JSON responses into typed models."""

from moodle_cli.models import Activity, Course, Section, UserInfo


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
