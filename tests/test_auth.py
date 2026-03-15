from __future__ import annotations

import os
import types
from http.cookiejar import Cookie, CookieJar

import pytest

import moodle_cli.auth as auth_module

BASE_URL = "https://school.example.edu"
DOMAIN = "school.example.edu"


def make_cookie(value: str, domain: str = DOMAIN) -> Cookie:
    return Cookie(
        version=0,
        name="MoodleSession",
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

    assert auth_module._load_from_okta(BASE_URL) == "fresh-session"
    assert calls == [
        ("get_cookie_value", BASE_URL),
        ("ensure_login", BASE_URL),
        ("get_cookie_value", BASE_URL),
    ]
