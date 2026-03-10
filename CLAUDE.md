# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent Flags

```yaml
agent_flags:
  token_economy: prioritize
  response_style: terse
  planning_style: minimal
```

Interpret these as defaults:

- Prefer the shortest sufficient response.
- Avoid long preambles and repeated summaries.
- Ask questions only when a wrong assumption is likely to be costly.
- Make the smallest maintainable change that solves the task.

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

Uses Moodle's **internal AJAX endpoint** (`/lib/ajax/service.php`), not the official Web Services token API. This endpoint accepts the `MoodleSession` browser cookie, same as the Moodle web UI. The client first loads an authenticated page to resolve `sesskey`, then tries AJAX APIs and falls back to page scraping when site-specific Moodle restrictions disable some services.

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
- **config.py**: Loads `config.yaml` from CWD or `~/.config/moodle-cli/`. If no `base_url` is configured, it prompts the user, validates the root URL, probes the site, and saves the result. `MOODLE_BASE_URL` env var overrides.
- **constants.py**: API paths, function names, env var names.

### Adding a New Command

1. Add the Moodle AJAX function name to `constants.py`
2. Add a method to `MoodleClient` in `client.py` (call `self._ensure_session()` first)
3. Add model dataclass to `models.py`, parser function to `parser.py`
4. Add Rich display function to `formatter.py`
5. Add `@cli.command()` in `cli.py` with `--json`/`--yaml` options

### Adding a New Moodle API Call

All API calls go through `MoodleClient._call(function_name, args)`. It handles the AJAX envelope format and error extraction. Just add a new public method that calls `self._call()` with the right function name.
