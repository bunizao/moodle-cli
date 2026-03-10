# moodle-cli

Terminal-first CLI for Moodle LMS that reuses an authenticated browser session.

Repository: <https://github.com/bunizao/moodle-cli>

## Features

- No API token setup required
- Reads `MoodleSession` from your browser or `MOODLE_SESSION`
- Works with Moodle AJAX APIs and falls back to authenticated page scraping when needed
- Terminal output plus `--json` and `--yaml`

## Requirements

- Python 3.10+
- `uv`
- An active Moodle browser session, or a `MOODLE_SESSION` environment variable

## Install

```bash
uv sync
```

## Usage

```bash
uv run moodle --help
uv run moodle user
uv run moodle courses
uv run moodle activities 34637
```

## Configuration

Create `config.yaml` in the project directory or in `~/.config/moodle-cli/`:

```yaml
base_url: https://learning.monash.edu
```

Environment overrides:

- `MOODLE_BASE_URL`
- `MOODLE_SESSION`

## Development

```bash
uv run python -m compileall moodle_cli
uv build
```

## CI

GitHub Actions runs the following checks on pushes and pull requests:

- Dependency lock sync with `uv`
- Bytecode compilation
- CLI smoke check
- Package build
