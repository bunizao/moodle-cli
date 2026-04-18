"""Version helpers."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
import re

PACKAGE_DIST_NAME = "moodle-cli"
_PYPROJECT_VERSION_RE = re.compile(r'(?m)^version\s*=\s*"([^"]+)"\s*$')


def read_local_version() -> str:
    """Read the version declared in pyproject.toml."""
    pyproject_path = Path(__file__).resolve().parent.parent / "pyproject.toml"

    try:
        contents = pyproject_path.read_text(encoding="utf-8")
    except OSError:
        return "0.0.0"

    match = _PYPROJECT_VERSION_RE.search(contents)
    return match.group(1) if match else "0.0.0"


def get_version() -> str:
    """Return the installed package version, falling back to the local project version."""
    try:
        return package_version(PACKAGE_DIST_NAME)
    except PackageNotFoundError:
        return read_local_version()


__version__ = get_version()
