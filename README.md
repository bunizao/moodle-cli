# moodle-cli

Terminal-first CLI for Moodle LMS that reuses an authenticated browser session.

## Features

- No API token setup required
- Reads `MoodleSession` from your browser or `MOODLE_SESSION`
- Works with Moodle AJAX APIs and falls back to authenticated page scraping when needed
- Upcoming timeline items for student-facing deadlines and actions
- Terminal output plus `--json` and `--yaml`

## Requirements

- Python 3.10+
- `uv`
- An active Moodle browser session, or a `MOODLE_SESSION` environment variable

## Install

```bash
# Recommended: uv tool
uv tool install moodle-cli

# Alternative: pipx
pipx install moodle-cli
```

Install from source:

```bash
git clone https://github.com/bunizao/moodle-cli.git
cd moodle-cli
uv sync
```

## Usage

```bash
moodle --help
moodle user
moodle alerts
moodle todo
moodle overview
moodle courses
moodle grades 34637
moodle activities 34637
moodle update
```

To upgrade after an update is available:

```bash
uv tool upgrade moodle-cli
# or
pipx upgrade moodle-cli
```

## Configuration

On first run, if no `base_url` is configured, the CLI will prompt you and write it to `config.yaml` in the project directory or in `~/.config/moodle-cli/`:

```yaml
base_url: https://school.example.edu
```

Required format:

- Use a full root URL such as `https://school.example.edu`
- Do not include paths, query strings, or fragments
- Do not use URLs like `/login/index.php` or `/my/`
- The CLI validates the URL against Moodle's token endpoint and asks again if it does not look valid

You can also set `MOODLE_BASE_URL` instead of using the interactive prompt.
You can copy from `config.example.yaml`.

Environment overrides:

- `MOODLE_BASE_URL`
- `MOODLE_SESSION`

## Development

```bash
uv run python -m compileall moodle_cli
uv build
```
