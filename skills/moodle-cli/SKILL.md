---
name: moodle-cli
description: "Reads Moodle units, deadlines, grades and files; submits coursework, manages messages and forums, and runs a private MCP server. Use when the user names Moodle, or asks about deadlines, assignments, quiz results, grades and marker feedback, announcements, lecture slides, workshop or unit pages, unit files or Moodle messages: \"what's due this week\", \"did my marks come back\", \"what did I get wrong on the week 5 quiz\", \"download the week 8 slides\", \"any new announcements\", \"submit my assignment\". Moodle is the default home of a unit's pages, quizzes, announcements and deadlines unless the user names Ed or OnTrack. OnTrack portfolio tasks belong to ontrack-cli; Ed forum threads and Ed lessons belong to edstem-cli. Not for writing Moodle plugins or running a Moodle server."
---

# Moodle CLI

UNIT is a code/name, id or URL; SECTION is a number/name. Discover with `moodle courses`.

Details live in two reference files: [setup, sign-in and the private MCP server](references/setup-and-auth.md), and [downloads, sync, grades options and MCP behaviour](references/usage.md).

## What the user says, and what to run

| The user says | CLI | MCP tool | Then |
| --- | --- | --- | --- |
| dashboard | `moodle` | `moodle:home` | unit or item |
| deadlines | `moodle due [UNIT] --days 14` | `moodle:due` | item with activity_id |
| unit names | `moodle courses` | `moodle:units` | unit with a name or id |
| a unit or section | `moodle UNIT [SECTION]` | `moodle:unit` | item or file with activity id |
| find slides or a task | `moodle find "QUERY" [UNIT]` | `moodle:find` | item or file with id |
| submission or item detail | `moodle UNIT "TASK"` | `moodle:item` | file with a file id, or attempt with an attempt id |
| a quiz attempt | `moodle attempt ID` | `moodle:attempt` | item with quiz_id |
| grades | `moodle grades [UNIT]` | `moodle:grades` | offset; item id |
| announcements | `moodle news [UNIT]` | `moodle:news` | thread with discussion id |
| discussion posts | `moodle threads show ID` | `moodle:thread` | increase offset while posts_total exceeds returned |
| forum post text | `moodle forums search "QUERY" --unit UNIT` | `moodle:search_forums` | thread with discussion_id |
| upload assignment files | `moodle submit "UNIT TASK" FILE... [--final]` | `moodle:submit` | dry_run (default) only plans; show the plan to the person, then rerun with dry_run false; final submits for grading and cannot be undone; without a draft stage saving is the submission, so it is refused unless final is true |
| download a file | `moodle dl "UNIT TASK" --to DIR` | `moodle:file` | read the returned image or resource |
| messages | `moodle messages list` | `moodle:messages` | conversation with id |
| read a conversation | `moodle messages show ID` | `moodle:conversation` | increase offset for older messages |
| calendar events | `moodle calendar --days 14` | `moodle:calendar` | item for an activity |

## Workflows

Copy the checklist into your reply and tick each step as it is done; the last step is what shows the change landed.

### Change something upstream

```text
- [ ] Check the user asked for this change, on these targets
- [ ] Run the command with `--dry-run` and show the plan
- [ ] Get the user's yes to that plan
- [ ] Run it again with `--yes`
- [ ] Read the result back with the matching `list` or `show` and report what changed
```

### Submit an assignment

```text
- [ ] Open it with `moodle UNIT "TASK"` and check the status, file limits and accepted types
- [ ] Run `moodle submit "UNIT TASK" FILE... --dry-run` and show the plan: files, statement, draft or final
- [ ] Get the user's yes, and a separate yes for `--final`: it submits for grading and Moodle cannot undo it
- [ ] Run it again with `--yes`, plus `--final` only when the user said so. Without a draft stage, saving is the submission, so Moodle needs `--final`
- [ ] Open it again with `moodle UNIT "TASK"` and confirm the files and submission status
```

## Rules

- Start from the table row that matches the request: the narrowest command or tool answers sooner and costs fewer tokens than a broad listing.
- Piped output is JSON. `--fields a,b` keeps only those top-level fields, which keeps long lists cheap.
- `read` prints Markdown and changes nothing upstream, so it is safe to run unasked.
- Change something upstream only when the user asked for that change: other people see it, and most changes cannot be undone.
- Keep tokens, cookies and session files out of replies, logs and files; each one is a live sign-in.
- A failure prints one error with a `hint` on stderr; follow the hint before retrying.
- Ambiguity returns `candidates`: refine the reference or pick one. Ids differ per site, so a guessed one can open the wrong unit.
- Lists report `total`: narrow the request or page with `--limit` and `--offset`.
- A pairing code is a sign-in too: keep it out of replies and never paste one into a web form.
- `alerts read` and `messages read` are the exception to the `read` rule: they mark items read on Moodle, so run them only when asked.
- Every command, argument, option and exit code is in [references/commands.md](references/commands.md); `moodle commands --json` is the source of truth.

## Setup

Sign in with `moodle doctor`; when a remote MCP session has expired, run `moodle mcp login`. `moodle mcp serve` starts the local stdio MCP server; `moodle mcp deploy` sets up a private remote one. See [setup](references/setup-and-auth.md).
