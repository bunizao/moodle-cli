---
name: moodle-cli
description: Read Moodle units, deadlines, grades and files; submit coursework, manage messages and forums, and run a private MCP server.
---

# Moodle CLI

UNIT is a code/name, id or URL; SECTION is a number/name. Discover with `moodle courses`; never guess ids.

Details live in two reference files: [setup, sign-in and the private MCP server](references/setup-and-auth.md), and [downloads, sync, grades options and MCP behaviour](references/usage.md).

## What the user says, and what to run

| The user says | Run | Then |
| --- | --- | --- |
| dashboard | `moodle` | unit or item |
| deadlines | `moodle due [UNIT] --days 14` | item with activity_id |
| unit names | `moodle courses` | unit with a name or id |
| a unit or section | `moodle UNIT [SECTION]` | item or file with activity id |
| find slides or a task | `moodle find "QUERY" [UNIT]` | item or file with id |
| submission or item detail | `moodle UNIT "TASK"` | file with a file id, or attempt with an attempt id |
| a quiz attempt | `moodle attempt ID` | item with quiz_id |
| grades | `moodle grades [UNIT]` | offset; item id |
| announcements | `moodle news [UNIT]` | thread with discussion id |
| discussion posts | `moodle threads show ID` | increase offset while posts_total exceeds returned |
| forum post text | `moodle forums search "QUERY" --unit UNIT` | thread with discussion_id |
| upload assignment files | `moodle submit "UNIT TASK" FILE... [--final]` | dry_run (default) only plans; show the plan to the person, then rerun with dry_run false; final submits for grading and cannot be undone; without a draft stage saving is the submission, so it is refused unless final is true |
| download a file | `moodle dl "UNIT TASK" --to DIR` | read the returned image or resource |
| messages | `moodle messages list` | conversation with id |
| read a conversation | `moodle messages show ID` | increase offset for older messages |
| calendar events | `moodle calendar --days 14` | item for an activity |

## MCP tools

| The user says | Tool |
| --- | --- |
| dashboard | `home` |
| deadlines | `due` |
| unit names | `units` |
| a unit or section | `unit` |
| find slides or a task | `find` |
| submission or item detail | `item` |
| a quiz attempt | `attempt` |
| grades | `grades` |
| announcements | `news` |
| discussion posts | `thread` |
| forum post text | `search_forums` |
| upload assignment files | `submit` |
| download a file | `file` |
| messages | `messages` |
| read a conversation | `conversation` |
| calendar events | `calendar` |

## Rules

- Run the narrowest command or tool that answers the request; one call per intent.
- Piped output is JSON and a terminal gets a table. `--fields a,b` keeps only the listed top-level fields.
- `read` prints Markdown and never changes anything upstream.
- Run a mutating command only when the user asked for it. It needs a confirmation or `--yes`; `--dry-run` prints the plan first.
- Never print, log or store tokens, cookies or session files.
- Ambiguity returns `candidates`: refine the reference or pick one; never guess ids.
- Lists report `total`: narrow the request or page with `--limit` and `--offset`.
- Dry-run submissions first (`moodle submit ... --dry-run`), show the plan, then confirm. `--final` submits for grading and is irreversible.
- Never expose cookies, tokens or pairing codes. Never paste a pairing code into a web form.
- `alerts read` and `messages read` are the exception to the `read` rule: they mark items read on Moodle, so run them only when asked.
- `--json` forces JSON, `--pretty` indents it and `--yaml` writes YAML. Errors are `{ok:false,error:{code,message,hint},exit_code}` on stderr.
- Every command, argument and option is in [references/commands.md](references/commands.md); `moodle commands --json` is the source of truth.

## Setup

Sign in with `moodle doctor`; when a remote MCP session has expired, run `moodle mcp login`. `moodle mcp serve` starts the local stdio MCP server; `moodle mcp deploy` sets up a private remote one. See [setup](references/setup-and-auth.md).

## Errors

Errors are printed once on stderr. Exit codes: 0 success, 2 usage, 3 auth, 1 config, 4 not_found, 5 upstream, 1 network, 130 cancelled, 1 unexpected.
