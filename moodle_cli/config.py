"""Config loading and first-run base URL setup."""

from pathlib import Path
import os
from urllib.parse import urlparse

import click
import requests
import yaml

from moodle_cli.constants import CONFIG_DIR, CONFIG_FILENAME, ENV_MOODLE_BASE_URL
from moodle_cli.exceptions import MoodleCLIError

CONFIG_PROMPT = "Enter your Moodle base URL"


def _config_candidates() -> list[Path]:
    return [
        Path.cwd() / CONFIG_FILENAME,
        Path(CONFIG_DIR).expanduser() / CONFIG_FILENAME,
    ]


def _find_config_file() -> Path | None:
    """Search for config.yaml in CWD, then ~/.config/moodle-cli/."""
    for path in _config_candidates():
        if path.is_file():
            return path
    return None


def _default_config_path() -> Path:
    cwd_config = Path.cwd() / CONFIG_FILENAME
    if cwd_config.exists():
        return cwd_config
    return Path(CONFIG_DIR).expanduser() / CONFIG_FILENAME


def _read_config_file(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _save_config(path: Path, config: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(config, f, sort_keys=True)


def _validate_base_url(value: str) -> str:
    raw = value.strip()
    if not raw:
        raise MoodleCLIError("Base URL cannot be empty.")
    if "://" not in raw:
        raise MoodleCLIError("Base URL must include the scheme, for example https://school.example.edu")

    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"}:
        raise MoodleCLIError("Base URL must start with http:// or https://")
    if not parsed.hostname:
        raise MoodleCLIError("Base URL must include a hostname")
    if parsed.query or parsed.fragment:
        raise MoodleCLIError("Base URL must not include query parameters or fragments")
    if parsed.path not in {"", "/"}:
        raise MoodleCLIError("Base URL must be the site root, for example https://school.example.edu")

    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def _probe_base_url(base_url: str) -> tuple[bool, str]:
    """Check whether the configured URL looks reachable and likely Moodle."""
    try:
        response = requests.get(f"{base_url}/login/index.php", timeout=10, allow_redirects=True)
    except requests.RequestException as exc:
        return False, f"Could not reach {base_url}: {exc}"

    content_type = response.headers.get("content-type", "").lower()
    body = response.text[:5000].lower()
    looks_html = "text/html" in content_type or "<html" in body
    looks_moodle = "moodle" in body or "log in" in body or "/login/index.php" in body

    if response.status_code >= 400:
        return False, f"{base_url} returned HTTP {response.status_code}"
    if not looks_html:
        return False, f"{base_url} did not return an HTML page"
    if not looks_moodle:
        return False, f"{base_url} does not look like a Moodle site"

    return True, ""


def _prompt_for_base_url() -> str:
    click.echo("No Moodle base URL configured.")
    click.echo("Example: https://school.example.edu")

    while True:
        value = click.prompt(CONFIG_PROMPT, type=str)
        try:
            base_url = _validate_base_url(value)
        except MoodleCLIError as exc:
            click.echo(f"Invalid URL: {exc}")
            continue

        looks_valid, message = _probe_base_url(base_url)
        if not looks_valid:
            click.echo(f"Warning: {message}")
            if not click.confirm("Save this URL anyway?", default=False):
                continue

        if click.confirm(f"Use {base_url}?", default=True):
            return base_url


def load_config() -> dict:
    """Load configuration, prompting once for base_url when needed."""
    config: dict = {}
    config_file = _find_config_file()
    if config_file:
        config = _read_config_file(config_file)

    if env_url := os.environ.get(ENV_MOODLE_BASE_URL):
        config["base_url"] = _validate_base_url(env_url)
        return config

    if base_url := config.get("base_url"):
        config["base_url"] = _validate_base_url(str(base_url))
        return config

    if not click.get_text_stream("stdin").isatty():
        raise MoodleCLIError(
            "No base_url configured. Set MOODLE_BASE_URL or add base_url to config.yaml before running non-interactively."
        )

    base_url = _prompt_for_base_url()
    config["base_url"] = base_url

    target_path = config_file or _default_config_path()
    _save_config(target_path, config)
    click.echo(f"Saved base_url to {target_path}")
    return config
