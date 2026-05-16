from __future__ import annotations

import pytest

from moodle_cli.client import MoodleClient
from moodle_cli.models import UserInfo
from moodle_cli.scraper import PageContext

BASE_URL = "https://school.example.edu"


def test_preloaded_page_context_skips_dashboard_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    context = PageContext(
        sesskey="sesskey",
        user_info=UserInfo(
            userid=7,
            username="",
            fullname="Alice Example",
            sitename="Campus",
            siteurl=BASE_URL,
            lang="en",
        ),
    )
    client = MoodleClient(BASE_URL, "session-cookie", page_context=context)

    monkeypatch.setattr(client, "_get", lambda *_args, **_kwargs: pytest.fail("dashboard should not be fetched"))

    client._ensure_session()
    assert client._sesskey == "sesskey"
    assert client._userid == 7


def test_client_preserves_custom_moodle_session_cookie_name() -> None:
    session_cookie = type("SessionCookie", (str,), {})("session-cookie")
    session_cookie.name = "MoodleSessionmoodle"

    client = MoodleClient(BASE_URL, session_cookie)

    assert client.session.cookies.get("MoodleSessionmoodle") == "session-cookie"
    assert client.session.cookies.get("MoodleSession") is None
