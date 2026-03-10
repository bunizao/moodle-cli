"""Config loading: config.yaml from CWD or ~/.config/moodle-cli/."""

from pathlib import Path

import yaml

from moodle_cli.constants import (
    CONFIG_DIR,
    CONFIG_FILENAME,
    DEFAULT_BASE_URL,
    ENV_MOODLE_BASE_URL,
)
import os


def _find_config_file() -> Path | None:
    """Search for config.yaml in CWD, then ~/.config/moodle-cli/."""
    candidates = [
        Path.cwd() / CONFIG_FILENAME,
        Path(CONFIG_DIR).expanduser() / CONFIG_FILENAME,
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def load_config() -> dict:
    """Load configuration, merging file config with env var overrides.

    Returns a dict with at least 'base_url'.
    """
    config: dict = {}

    config_file = _find_config_file()
    if config_file:
        with open(config_file) as f:
            config = yaml.safe_load(f) or {}

    # Env var overrides
    if env_url := os.environ.get(ENV_MOODLE_BASE_URL):
        config["base_url"] = env_url.rstrip("/")

    # Ensure base_url always has a value
    config.setdefault("base_url", DEFAULT_BASE_URL)
    # Normalize: strip trailing slash
    config["base_url"] = config["base_url"].rstrip("/")

    return config
