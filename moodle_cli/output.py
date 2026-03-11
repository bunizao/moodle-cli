"""Structured output: --json and --yaml support."""

import json
import sys
from typing import Any

import yaml


def optimize_json_data(data: Any) -> Any:
    """Remove empty JSON values recursively to keep agent-facing output compact."""
    if isinstance(data, dict):
        compact = {
            key: optimize_json_data(value)
            for key, value in data.items()
        }
        return {
            key: value
            for key, value in compact.items()
            if value not in (None, "", [], {})
        }

    if isinstance(data, list):
        compact = [optimize_json_data(item) for item in data]
        return [item for item in compact if item not in (None, "", [], {})]

    return data


def output_json(data: dict | list) -> None:
    """Print compact JSON to stdout."""
    json.dump(optimize_json_data(data), sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


def output_yaml(data: dict | list) -> None:
    """Print data as YAML to stdout."""
    yaml.dump(data, sys.stdout, default_flow_style=False, allow_unicode=True)
