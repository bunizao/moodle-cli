"""Structured output: --json and --yaml support."""

import json
import sys

import yaml


def output_json(data: dict | list) -> None:
    """Print data as formatted JSON to stdout."""
    json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


def output_yaml(data: dict | list) -> None:
    """Print data as YAML to stdout."""
    yaml.dump(data, sys.stdout, default_flow_style=False, allow_unicode=True)
