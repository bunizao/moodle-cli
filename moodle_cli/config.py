"""Config loading and validation."""

from pathlib import Path
import os
from urllib.parse import urlparse

import click
import requests
import yaml

from moodle_cli.constants import CONFIG_DIR, CONFIG_FILENAME, ENV_MOODLE_BASE_URL
from moodle_cli.exceptions import MoodleCLIError


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


def _load_existing_config() -> tuple[dict, Path | None]:
    config_file = _find_config_file()
    config = _read_config_file(config_file) if config_file else {}
    return config, config_file


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


def _missing_base_url_message(config_file: Path | None) -> str:
    target_path = config_file or _default_config_path()
    return "\n".join(
        [
            "No base_url configured.",
            f"Add base_url to {target_path} or set MOODLE_BASE_URL.",
            "Required format:",
            "  base_url: https://school.example.edu",
            "Use the site root only. Do not include paths like /login/index.php or /my/.",
        ]
    )


def _probe_base_url(base_url: str) -> tuple[bool, str]:
    """Check whether the configured URL exposes a Moodle-specific endpoint."""
    try:
        response = requests.get(f"{base_url}/login/token.php", timeout=10, allow_redirects=True)
    except requests.RequestException as exc:
        return False, f"Could not reach {base_url}: {exc}"

    content_type = response.headers.get("content-type", "").lower()
    body = response.text[:5000].lower()
    looks_json = "application/json" in content_type or body.startswith("{")
    looks_moodle_token_error = any(
        marker in body
        for marker in [
            '"errorcode":"missingparam"',
            '"errorcode":"invalidparameter"',
            '"errorcode":"invalidlogin"',
            "a required parameter (username) was missing",
        ]
    )

    if response.status_code >= 400:
        return False, f"{base_url} returned HTTP {response.status_code}"
    if looks_json and looks_moodle_token_error:
        return True, ""

    return False, f"{base_url} does not expose the expected Moodle token endpoint"


def _prompt_for_base_url() -> str:
    click.secho("\nConfiguration required", fg="yellow", bold=True)
    click.secho("Moodle base URL is not configured yet.", fg="yellow")
    click.secho("Required format: https://school.example.edu", fg="cyan", bold=True)
    click.echo("Use the site root only. Do not include paths like /login/index.php or /my/.")
    click.echo()

    while True:
        try:
            base_url = _validate_base_url(
                click.prompt(
                    click.style("Moodle base URL", fg="green", bold=True),
                    prompt_suffix=click.style(" > ", fg="green", bold=True),
                    type=str,
                )
            )
        except MoodleCLIError as exc:
            click.secho(f"Invalid URL: {exc}", fg="red")
            continue

        looks_valid, message = _probe_base_url(base_url)
        if looks_valid:
            return base_url

        click.secho(f"Validation failed: {message}", fg="red")


def load_config() -> dict:
    """Load configuration and require an explicit base_url."""
    config, config_file = _load_existing_config()

    if env_url := os.environ.get(ENV_MOODLE_BASE_URL):
        config["base_url"] = _validate_base_url(env_url)
        return config

    if base_url := config.get("base_url"):
        config["base_url"] = _validate_base_url(str(base_url))
        return config

    if click.get_text_stream("stdin").isatty():
        config["base_url"] = _prompt_for_base_url()
        target_path = config_file or _default_config_path()
        _save_config(target_path, config)
        click.echo(f"Saved base_url to {target_path}")
        return config

    raise MoodleCLIError(_missing_base_url_message(config_file))
