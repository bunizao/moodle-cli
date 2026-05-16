from __future__ import annotations

import os
import json
import subprocess
import types
from http.cookiejar import Cookie, CookieJar

import pytest

import moodle_cli.auth as auth_module
from moodle_cli.models import UserInfo
from moodle_cli.scraper import PageContext

BASE_URL = "https://school.example.edu"
DOMAIN = "school.example.edu"


def make_page_context() -> PageContext:
    return PageContext(
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


def make_cookie(value: str, domain: str = DOMAIN, name: str = "MoodleSession") -> Cookie:
    return Cookie(
        version=0,
        name=name,
        value=value,
        port=None,
        port_specified=False,
        domain=domain,
        domain_specified=True,
        domain_initial_dot=False,
        path="/",
        path_specified=True,
        secure=True,
        expires=None,
        discard=True,
        comment=None,
        comment_url=None,
        rest={},
        rfc2109=False,
    )


def make_cookie_jar(*values: str) -> CookieJar:
    jar = CookieJar()
    for value in values:
        jar.set_cookie(make_cookie(value))
    return jar


def test_iter_cookie_values_accepts_suffixed_moodle_session_cookie() -> None:
    jar = CookieJar()
    jar.set_cookie(make_cookie("suffixed-session", name="MoodleSessionmoodle"))

    cookies = list(auth_module._iter_cookie_values(jar, DOMAIN))

    assert cookies == ["suffixed-session"]
    assert cookies[0].name == "MoodleSessionmoodle"


def test_iter_browser_sessions_keeps_same_value_with_different_cookie_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    jar = CookieJar()
    jar.set_cookie(make_cookie("shared-session"))
    jar.set_cookie(make_cookie("shared-session", name="MoodleSessionmoodle"))

    monkeypatch.setattr(auth_module, "_chromium_cookie_files", lambda browser: ["profile"] if browser == "Chrome" else [])
    fake_browser_cookie3 = types.SimpleNamespace(
        chrome=lambda **_kwargs: jar,
        firefox=lambda **_kwargs: make_cookie_jar(),
        brave=lambda **_kwargs: make_cookie_jar(),
        edge=lambda **_kwargs: make_cookie_jar(),
    )
    monkeypatch.setitem(os.sys.modules, "browser_cookie3", fake_browser_cookie3)

    cookies = list(auth_module._iter_browser_sessions(DOMAIN))

    assert [(cookie.name, str(cookie)) for cookie in cookies] == [
        ("MoodleSession", "shared-session"),
        ("MoodleSessionmoodle", "shared-session"),
    ]


def test_validate_session_uses_preserved_cookie_name(monkeypatch: pytest.MonkeyPatch) -> None:
    context = make_page_context()
    calls: list[tuple[str, str]] = []

    class FakeCookies:
        def set(self, name: str, value: str) -> None:
            calls.append((name, value))

    class FakeResponse:
        text = "<html></html>"

        def raise_for_status(self) -> None:
            return None

    class FakeSession:
        def __init__(self) -> None:
            self.cookies = FakeCookies()

        def get(self, url: str, **_kwargs) -> FakeResponse:
            assert url == f"{BASE_URL}/my/"
            return FakeResponse()

    cookie = auth_module.MoodleSessionCookie("session-cookie", "MoodleSessionmoodle")

    monkeypatch.setattr(auth_module.requests, "Session", FakeSession)
    monkeypatch.setattr(auth_module, "parse_page_context", lambda _html, _base_url: context)

    assert auth_module._validate_session(BASE_URL, cookie) is context
    assert calls == [("MoodleSessionmoodle", "session-cookie")]


def test_get_session_checks_multiple_chrome_profiles_and_returns_valid_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MOODLE_SESSION", raising=False)
    monkeypatch.setattr(auth_module, "_chromium_cookie_files", lambda browser: ["default", "profile-3"] if browser == "Chrome" else [])
    monkeypatch.setattr(auth_module, "_is_valid_session", lambda _base_url, value: value == "good-session")

    def fake_chrome(*, domain_name: str, cookie_file: str | None = None):
        assert domain_name == DOMAIN
        if cookie_file == "default":
            return make_cookie_jar("stale-session")
        if cookie_file == "profile-3":
            return make_cookie_jar("good-session")
        return make_cookie_jar()

    fake_browser_cookie3 = types.SimpleNamespace(
        chrome=fake_chrome,
        firefox=lambda **_kwargs: make_cookie_jar(),
        brave=lambda **_kwargs: make_cookie_jar(),
        edge=lambda **_kwargs: make_cookie_jar(),
    )
    monkeypatch.setitem(os.sys.modules, "browser_cookie3", fake_browser_cookie3)

    assert auth_module.get_session(BASE_URL) == "good-session"


def test_get_session_falls_back_from_invalid_env_session_to_browser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MOODLE_SESSION", "env-session")
    monkeypatch.setattr(auth_module, "_chromium_cookie_files", lambda browser: ["profile-2"] if browser == "Chrome" else [])
    monkeypatch.setattr(auth_module, "_is_valid_session", lambda _base_url, value: value == "browser-session")

    def fake_chrome(*, domain_name: str, cookie_file: str | None = None):
        assert domain_name == DOMAIN
        if cookie_file == "profile-2":
            return make_cookie_jar("browser-session")
        return make_cookie_jar()

    fake_browser_cookie3 = types.SimpleNamespace(
        chrome=fake_chrome,
        firefox=lambda **_kwargs: make_cookie_jar(),
        brave=lambda **_kwargs: make_cookie_jar(),
        edge=lambda **_kwargs: make_cookie_jar(),
    )
    monkeypatch.setitem(os.sys.modules, "browser_cookie3", fake_browser_cookie3)

    assert auth_module.get_session(BASE_URL) == "browser-session"


def test_get_session_uses_okta_auth_before_browser(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MOODLE_SESSION", raising=False)
    monkeypatch.setattr(auth_module, "_load_from_okta", lambda _base_url: "okta-session")
    monkeypatch.setattr(auth_module, "_is_valid_session", lambda _base_url, value: value == "okta-session")
    monkeypatch.setattr(auth_module, "_iter_browser_sessions", lambda _domain: pytest.fail("browser fallback should not run"))

    assert auth_module.get_session(BASE_URL) == "okta-session"


def test_get_authenticated_session_returns_env_context_without_okta_or_browser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = make_page_context()
    calls: list[tuple[str, str]] = []

    def fake_validate(base_url: str, value: str) -> PageContext | None:
        calls.append((base_url, value))
        return context

    monkeypatch.setenv("MOODLE_SESSION", "env-session")
    monkeypatch.setattr(auth_module, "_validate_session", fake_validate)
    monkeypatch.setattr(auth_module, "_load_from_okta_with_context", lambda _base_url: pytest.fail("okta should not run"))
    monkeypatch.setattr(auth_module, "_iter_browser_sessions", lambda _domain: pytest.fail("browser fallback should not run"))

    assert auth_module.get_authenticated_session(BASE_URL) == ("env-session", context)
    assert calls == [(BASE_URL, "env-session")]


def test_get_authenticated_session_preserves_browser_cookie_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = make_page_context()
    cookie = auth_module.MoodleSessionCookie("browser-session", "MoodleSessionmoodle")

    monkeypatch.delenv("MOODLE_SESSION", raising=False)
    monkeypatch.setattr(auth_module, "_load_from_okta_with_context", lambda _base_url: None)
    monkeypatch.setattr(auth_module, "_iter_browser_sessions", lambda _domain: iter([cookie]))
    monkeypatch.setattr(auth_module, "_validate_session", lambda _base_url, value: context if value is cookie else None)

    session, page_context = auth_module.get_authenticated_session(BASE_URL)

    assert session == "browser-session"
    assert session.name == "MoodleSessionmoodle"
    assert page_context is context


def test_load_from_okta_triggers_login_when_stored_cookie_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []

    def fake_get_cookie_value(base_url: str, cookie_name: str) -> str | None:
        calls.append(("get_cookie_value", base_url))
        if len(calls) == 1:
            return None
        assert cookie_name == "MoodleSession"
        return "fresh-session"

    def fake_ensure_login(base_url: str) -> dict[str, object]:
        calls.append(("ensure_login", base_url))
        return {"success": True, "performed_login": True}

    fake_adapter = types.SimpleNamespace(
        OktaAdapterError=RuntimeError,
        get_cookie_value=fake_get_cookie_value,
        ensure_login=fake_ensure_login,
    )
    monkeypatch.setitem(os.sys.modules, "okta_auth.adapter", fake_adapter)
    monkeypatch.setattr(auth_module, "_is_valid_session", lambda _base_url, value: value == "fresh-session")
    monkeypatch.setattr(auth_module, "_load_from_okta_cli", lambda _base_url, *, allow_login=True: None)

    assert auth_module._load_from_okta(BASE_URL) == "fresh-session"
    assert calls == [
        ("get_cookie_value", BASE_URL),
        ("ensure_login", BASE_URL),
        ("get_cookie_value", BASE_URL),
    ]


def test_load_from_okta_with_context_falls_back_to_okta_cli_suffixed_cookie(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = make_page_context()
    calls: list[list[str]] = []
    payload = {
        "count": 1,
        "cookies": [
            {"name": "MoodleSessionmoodle", "value": "stored-session", "domain": f".{DOMAIN}"},
        ],
        "url": BASE_URL,
    }

    fake_adapter = types.SimpleNamespace(
        OktaAdapterError=RuntimeError,
        get_cookie_value=lambda _base_url, _cookie_name: None,
        ensure_login=lambda _base_url: pytest.fail("adapter login should not run when CLI has a valid stored cookie"),
    )
    monkeypatch.setitem(os.sys.modules, "okta_auth.adapter", fake_adapter)
    monkeypatch.setattr(auth_module.shutil, "which", lambda name: "/usr/bin/okta" if name == "okta" else None)
    monkeypatch.setattr(auth_module, "_validate_session", lambda _base_url, value: context if value == "stored-session" else None)

    def fake_run(args, **kwargs):
        calls.append(args)
        assert kwargs == {
            "stdin": subprocess.DEVNULL,
            "capture_output": True,
            "text": True,
            "check": False,
        }
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(auth_module.subprocess, "run", fake_run)

    session, page_context = auth_module._load_from_okta_with_context(BASE_URL)

    assert session == "stored-session"
    assert session.name == "MoodleSessionmoodle"
    assert page_context is context
    assert calls == [["/usr/bin/okta", "cookies", BASE_URL, "--json"]]


def test_load_from_okta_cli_with_context_tries_next_cookie_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = make_page_context()
    validated_names: list[str] = []
    payload = {
        "count": 2,
        "cookies": [
            {"name": "MoodleSession", "value": "shared-session", "domain": f".{DOMAIN}"},
            {"name": "MoodleSessionmoodle", "value": "shared-session", "domain": f".{DOMAIN}"},
        ],
        "url": BASE_URL,
    }

    monkeypatch.setattr(auth_module.shutil, "which", lambda name: "/usr/bin/okta" if name == "okta" else None)

    def fake_validate(_base_url: str, value: str) -> PageContext | None:
        validated_names.append(value.name)
        return context if value.name == "MoodleSessionmoodle" else None

    def fake_run(args, **_kwargs):
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(auth_module, "_validate_session", fake_validate)
    monkeypatch.setattr(auth_module.subprocess, "run", fake_run)

    session, page_context = auth_module._load_from_okta_cli_with_context(BASE_URL, allow_login=False)

    assert session == "shared-session"
    assert session.name == "MoodleSessionmoodle"
    assert page_context is context
    assert validated_names == ["MoodleSession", "MoodleSessionmoodle"]


def test_load_from_okta_cli_uses_stored_cookie(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []
    payload = {
        "count": 1,
        "cookies": [
            {"name": "MoodleSession", "value": "stored-session", "domain": f".{DOMAIN}"},
        ],
        "url": BASE_URL,
    }

    monkeypatch.setattr(auth_module.shutil, "which", lambda name: "/usr/bin/okta" if name == "okta" else None)
    monkeypatch.setattr(auth_module, "_is_valid_session", lambda _base_url, value: value == "stored-session")

    def fake_run(args, **kwargs):
        calls.append(args)
        assert kwargs == {
            "stdin": subprocess.DEVNULL,
            "capture_output": True,
            "text": True,
            "check": False,
        }
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(auth_module.subprocess, "run", fake_run)

    assert auth_module._load_from_okta_cli(BASE_URL) == "stored-session"
    assert calls == [["/usr/bin/okta", "cookies", BASE_URL, "--json"]]


def test_load_from_okta_cli_triggers_login_when_cookie_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    monkeypatch.setattr(auth_module.shutil, "which", lambda name: "/usr/bin/okta" if name == "okta" else None)
    monkeypatch.setattr(auth_module, "_is_valid_session", lambda _base_url, value: value == "fresh-session")

    def fake_run(args, **kwargs):
        calls.append(args)
        assert kwargs == {
            "stdin": subprocess.DEVNULL,
            "capture_output": True,
            "text": True,
            "check": False,
        }
        command = args[1]
        if command == "cookies" and len(calls) == 1:
            payload = {"count": 0, "cookies": [], "url": BASE_URL}
        elif command == "login":
            payload = {"success": True, "message": "Login succeeded", "url": BASE_URL}
        elif command == "cookies" and len(calls) == 3:
            payload = {
                "count": 1,
                "cookies": [
                    {"name": "MoodleSession", "value": "fresh-session", "domain": DOMAIN},
                ],
                "url": BASE_URL,
            }
        else:
            raise AssertionError(f"Unexpected okta CLI invocation: {args}")

        return subprocess.CompletedProcess(args=args, returncode=0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(auth_module.subprocess, "run", fake_run)

    assert auth_module._load_from_okta_cli(BASE_URL) == "fresh-session"
    assert calls == [
        ["/usr/bin/okta", "cookies", BASE_URL, "--json"],
        ["/usr/bin/okta", "login", BASE_URL, "--json"],
        ["/usr/bin/okta", "cookies", BASE_URL, "--json"],
    ]
