"""Data models for Moodle entities."""

from dataclasses import dataclass, field


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
        return {
            "id": self.id,
            "shortname": self.shortname,
            "fullname": self.fullname,
            "category": self.category,
            "visible": self.visible,
            "startdate": self.startdate,
            "enddate": self.enddate,
        }


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
