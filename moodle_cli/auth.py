"""Authentication: extract MoodleSession cookie from env or browser."""

import glob
import logging
import os
import sys
from urllib.parse import urlparse

import requests

from moodle_cli.constants import DASHBOARD_PATH, ENV_MOODLE_SESSION
from moodle_cli.exceptions import AuthError
from moodle_cli.scraper import parse_page_context


log = logging.getLogger(__name__)


def load_from_env() -> str | None:
    """Check MOODLE_SESSION environment variable."""
    value = os.environ.get(ENV_MOODLE_SESSION)
    if value:
        log.debug("Using MoodleSession from environment variable")
    return value


def _glob_paths(patterns: list[str]) -> list[str]:
    """Expand filesystem glob patterns in a stable order."""
    paths: list[str] = []
    for pattern in patterns:
        paths.extend(sorted(glob.glob(os.path.expanduser(pattern))))
    return paths


def _chromium_cookie_files(browser: str) -> list[str]:
    """Return candidate cookie DB files for Chromium-based browsers."""
    platform_patterns = {
        "darwin": {
            "Chrome": [
                "~/Library/Application Support/Google/Chrome/Default/Cookies",
                "~/Library/Application Support/Google/Chrome/Guest Profile/Cookies",
                "~/Library/Application Support/Google/Chrome/Profile */Cookies",
            ],
            "Brave": [
                "~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
                "~/Library/Application Support/BraveSoftware/Brave-Browser/Guest Profile/Cookies",
                "~/Library/Application Support/BraveSoftware/Brave-Browser/Profile */Cookies",
            ],
            "Edge": [
                "~/Library/Application Support/Microsoft Edge/Default/Cookies",
                "~/Library/Application Support/Microsoft Edge/Guest Profile/Cookies",
                "~/Library/Application Support/Microsoft Edge/Profile */Cookies",
            ],
        },
        "linux": {
            "Chrome": [
                "~/.config/google-chrome/Default/Cookies",
                "~/.config/google-chrome/Profile */Cookies",
                "~/.var/app/com.google.Chrome/config/google-chrome/Default/Cookies",
                "~/.var/app/com.google.Chrome/config/google-chrome/Profile */Cookies",
            ],
            "Brave": [
                "~/.config/BraveSoftware/Brave-Browser/Default/Cookies",
                "~/.config/BraveSoftware/Brave-Browser/Profile */Cookies",
                "~/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/Default/Cookies",
                "~/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/Profile */Cookies",
            ],
            "Edge": [
                "~/.config/microsoft-edge/Default/Cookies",
                "~/.config/microsoft-edge/Profile */Cookies",
            ],
        },
        "win32": {
            "Chrome": [
                "~/AppData/Local/Google/Chrome/User Data/Default/Cookies",
                "~/AppData/Local/Google/Chrome/User Data/Default/Network/Cookies",
                "~/AppData/Local/Google/Chrome/User Data/Profile */Cookies",
                "~/AppData/Local/Google/Chrome/User Data/Profile */Network/Cookies",
            ],
            "Brave": [
                "~/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Cookies",
                "~/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies",
                "~/AppData/Local/BraveSoftware/Brave-Browser/User Data/Profile */Cookies",
                "~/AppData/Local/BraveSoftware/Brave-Browser/User Data/Profile */Network/Cookies",
            ],
            "Edge": [
                "~/AppData/Local/Microsoft/Edge/User Data/Default/Cookies",
                "~/AppData/Local/Microsoft/Edge/User Data/Default/Network/Cookies",
                "~/AppData/Local/Microsoft/Edge/User Data/Profile */Cookies",
                "~/AppData/Local/Microsoft/Edge/User Data/Profile */Network/Cookies",
            ],
        },
    }
    return _glob_paths(platform_patterns.get(sys.platform, {}).get(browser, []))


def _iter_cookie_values(cookie_jar, domain: str):
    """Yield matching MoodleSession values from a cookie jar."""
    for cookie in cookie_jar:
        if cookie.name == "MoodleSession" and domain in (cookie.domain or "") and cookie.value:
            yield cookie.value


def _iter_browser_sessions(domain: str):
    """Yield MoodleSession candidates from supported browsers.

    Chromium-based browsers are scanned profile-by-profile because some
    cookie loaders only read the first matching cookie DB.
    """
    try:
        import browser_cookie3  # noqa: F811
    except ImportError:
        log.warning("browser-cookie3 not installed; skipping browser cookie extraction")
        return

    loaders = [
        ("Chrome", browser_cookie3.chrome, _chromium_cookie_files("Chrome")),
        ("Firefox", browser_cookie3.firefox, [None]),
        ("Brave", browser_cookie3.brave, _chromium_cookie_files("Brave")),
        ("Edge", browser_cookie3.edge, _chromium_cookie_files("Edge")),
    ]
    seen_values: set[str] = set()

    for name, loader, cookie_files in loaders:
        attempts = cookie_files or [None]
        for cookie_file in attempts:
            try:
                kwargs = {"domain_name": domain}
                if cookie_file is not None:
                    kwargs["cookie_file"] = cookie_file
                cj = loader(**kwargs)
            except Exception as exc:
                source = cookie_file or "default profile"
                log.debug("Could not read cookies from %s (%s): %s", name, source, exc)
                continue

            for value in _iter_cookie_values(cj, domain):
                if value in seen_values:
                    continue
                seen_values.add(value)
                source = cookie_file or "default profile"
                log.debug("Found MoodleSession in %s (%s)", name, source)
                yield value


def _is_valid_session(base_url: str, moodle_session: str) -> bool:
    """Check whether a MoodleSession reaches an authenticated Moodle page."""
    session = requests.Session()
    session.cookies.set("MoodleSession", moodle_session)

    try:
        response = session.get(f"{base_url}{DASHBOARD_PATH}", allow_redirects=True, timeout=15)
        response.raise_for_status()
        parse_page_context(response.text, base_url)
    except (requests.RequestException, AuthError) as exc:
        log.debug("Rejected MoodleSession candidate: %s", exc)
        return False

    return True


def get_session(base_url: str) -> str:
    """Get a valid MoodleSession cookie value.

    Priority: env var → browser cookies.
    Raises AuthError if no session is found.
    """
    # 1. Environment variable
    session = load_from_env()
    if session and _is_valid_session(base_url, session):
        return session
    if session:
        log.debug("Ignored invalid MoodleSession from environment variable")

    # 2. Browser cookies
    domain = urlparse(base_url).hostname or ""
    for session in _iter_browser_sessions(domain):
        if _is_valid_session(base_url, session):
            return session

    raise AuthError(
        "No MoodleSession found. Either:\n"
        f"  1. Log in to {base_url} in your browser, or\n"
        f"  2. Set the {ENV_MOODLE_SESSION} environment variable"
    )
