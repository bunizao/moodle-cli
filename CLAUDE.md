# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
uv sync                    # install dependencies
uv run moodle --help       # run CLI
uv run moodle -v user      # verbose mode (debug logging)
```

Entry point: `moodle_cli.cli:main` (registered as `moodle` console script in pyproject.toml).

No tests exist yet. No linter/formatter is configured.

## Architecture

Terminal CLI for Moodle LMS that piggybacks on the user's browser session — no API tokens needed.

### API Strategy

Uses Moodle's **internal AJAX endpoint** (`/lib/ajax/service.php`), not the official Web Services token API. This endpoint accepts the `MoodleSession` browser cookie, same as the Moodle web UI. The `sesskey` (CSRF token) is obtained from `core_webservice_get_site_info` on first call, then reused.

Request format: `POST /lib/ajax/service.php?sesskey={sesskey}&info={function_name}` with JSON body `[{"index": 0, "methodname": "...", "args": {...}}]`. Response: `[{"error": false, "data": ...}]`.

### Data Flow

```
auth.py (get cookie) → client.py (API calls) → parser.py (JSON→models) → formatter.py/output.py (display)
         ↑                    ↑
    env var or            sesskey auto-obtained
    browser-cookie3       from get_site_info()
```

- **cli.py**: Click command group. `main()` wraps `cli(standalone_mode=False)` to handle `AuthError`/`MoodleAPIError` cleanly. Client is lazily created via `ctx.obj["get_client"]()` closure — auth only happens when a command actually needs the API.
- **auth.py**: Priority: `MOODLE_SESSION` env var → browser-cookie3 extraction (Chrome, Firefox, Brave, Edge). Arc browser is not supported by browser-cookie3.
- **client.py**: `MoodleClient` — holds session cookie, auto-obtains `sesskey`+`userid` on first API call via `_ensure_session()`.
- **models.py**: Dataclasses (`UserInfo`, `Course`, `Section`, `Activity`) with `to_dict()` for serialization.
- **parser.py**: Pure functions transforming Moodle JSON dicts → model instances.
- **formatter.py**: Rich tables (courses) and trees (course sections→activities).
- **output.py**: `--json`/`--yaml` structured output to stdout.
- **config.py**: Loads `config.yaml` from CWD or `~/.config/moodle-cli/`. `MOODLE_BASE_URL` env var overrides.
- **constants.py**: API paths, function names, env var names, default base URL (`learning.monash.edu`).

### Adding a New Command

1. Add the Moodle AJAX function name to `constants.py`
2. Add a method to `MoodleClient` in `client.py` (call `self._ensure_session()` first)
3. Add model dataclass to `models.py`, parser function to `parser.py`
4. Add Rich display function to `formatter.py`
5. Add `@cli.command()` in `cli.py` with `--json`/`--yaml` options

### Adding a New Moodle API Call

All API calls go through `MoodleClient._call(function_name, args)`. It handles the AJAX envelope format and error extraction. Just add a new public method that calls `self._call()` with the right function name.
