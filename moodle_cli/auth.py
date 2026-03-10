"""Authentication: extract MoodleSession cookie from env or browser."""

import os
import logging
from urllib.parse import urlparse

from moodle_cli.constants import ENV_MOODLE_SESSION
from moodle_cli.exceptions import AuthError

log = logging.getLogger(__name__)


def load_from_env() -> str | None:
    """Check MOODLE_SESSION environment variable."""
    value = os.environ.get(ENV_MOODLE_SESSION)
    if value:
        log.debug("Using MoodleSession from environment variable")
    return value


def load_from_browser(domain: str) -> str | None:
    """Extract MoodleSession cookie from browser cookie stores.

    Tries Arc, Chrome, Brave, Edge, Firefox in order.
    """
    try:
        import browser_cookie3  # noqa: F811
    except ImportError:
        log.warning("browser-cookie3 not installed; skipping browser cookie extraction")
        return None

    # browser-cookie3 loaders to try (in priority order)
    loaders = [
        ("Chrome", browser_cookie3.chrome),
        ("Firefox", browser_cookie3.firefox),
        ("Brave", browser_cookie3.brave),
        ("Edge", browser_cookie3.edge),
    ]

    for name, loader in loaders:
        try:
            cj = loader(domain_name=domain)
            for cookie in cj:
                if cookie.name == "MoodleSession" and domain in (cookie.domain or ""):
                    log.debug("Found MoodleSession in %s", name)
                    return cookie.value
        except Exception as exc:
            log.debug("Could not read cookies from %s: %s", name, exc)

    return None


def get_session(base_url: str) -> str:
    """Get a valid MoodleSession cookie value.

    Priority: env var → browser cookies.
    Raises AuthError if no session is found.
    """
    # 1. Environment variable
    session = load_from_env()
    if session:
        return session

    # 2. Browser cookies
    domain = urlparse(base_url).hostname or ""
    session = load_from_browser(domain)
    if session:
        return session

    raise AuthError(
        "No MoodleSession found. Either:\n"
        f"  1. Log in to {base_url} in your browser, or\n"
        f"  2. Set the {ENV_MOODLE_SESSION} environment variable"
    )
