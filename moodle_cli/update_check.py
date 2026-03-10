"""Check whether a newer moodle-cli release is available on PyPI."""

from dataclasses import dataclass

import requests
from packaging.version import InvalidVersion, Version

from moodle_cli import __version__
from moodle_cli.constants import PACKAGE_NAME, PYPI_JSON_URL
from moodle_cli.exceptions import MoodleCLIError


@dataclass
class UpdateInfo:
    """Version check result."""

    package_name: str
    current_version: str
    latest_version: str
    update_available: bool
    upgrade_commands: list[str]
    pypi_url: str

    def to_dict(self) -> dict:
        """Return a JSON/YAML-friendly representation."""
        return {
            "package_name": self.package_name,
            "current_version": self.current_version,
            "latest_version": self.latest_version,
            "update_available": self.update_available,
            "upgrade_commands": self.upgrade_commands,
            "pypi_url": self.pypi_url,
        }


def check_for_updates() -> UpdateInfo:
    """Fetch the latest release version from PyPI and compare it to the installed version."""
    try:
        response = requests.get(PYPI_JSON_URL, timeout=10)
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        raise MoodleCLIError(f"Could not check for updates: {exc}") from exc
    except ValueError as exc:
        raise MoodleCLIError("Could not check for updates: invalid response from PyPI") from exc

    latest_version = str(payload.get("info", {}).get("version", "")).strip()
    if not latest_version:
        raise MoodleCLIError("Could not check for updates: missing version in PyPI response")

    try:
        current = Version(__version__)
        latest = Version(latest_version)
    except InvalidVersion as exc:
        raise MoodleCLIError(f"Could not compare versions: {exc}") from exc

    return UpdateInfo(
        package_name=PACKAGE_NAME,
        current_version=__version__,
        latest_version=latest_version,
        update_available=latest > current,
        upgrade_commands=[
            f"uv tool upgrade {PACKAGE_NAME}",
            f"pipx upgrade {PACKAGE_NAME}",
        ],
        pypi_url=f"https://pypi.org/project/{PACKAGE_NAME}/",
    )
