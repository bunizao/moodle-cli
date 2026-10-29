---
name: moodle-cli
description: Read Moodle units, deadlines, grades and files; submit coursework, manage messages and forums, and run a private MCP server.
---

# Moodle CLI

UNIT is a code/name, id or URL; SECTION is a number/name. Discover with `moodle courses`; never guess ids.

Details live in two reference files: [setup, sign-in and the private MCP server](references/setup-and-auth.md), and [downloads, sync, grades options and MCP behaviour](references/command-reference.md).

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

| Tool | Description |
| --- | --- |
| `home` | Today's date and timezone, items due soon, unread counts and the current section of each unit. Use when the user says "dashboard". Instead: due for longer deadline lists. Input: days defaults to 14. Then: unit or item. Cost: small dashboard. |
| `due` | Items due in a date window. Use when the user says "deadlines". Instead: item for submission details. Input: unit code, name, id or URL. Then: item with activity_id. Cost: up to 20 rows by default. |
| `units` | Enrolled units with ids, codes and names. Use when the user says "unit names". Instead: unit for sections. Input: none. Then: unit with a name or id. Cost: small list. |
| `unit` | Section index and current section; section argument returns activities and files. Use when the user says "a unit or section". Instead: find for a named item. Input: unit code, name, id or URL; section number or name. Then: item or file with activity id. Cost: index about 4 KB; section about 0.5 KB. |
| `find` | Ranked sections, activities and discussion subjects. Use when the user says "find slides or a task". Instead: search_forums for post text; due for deadlines. Input: query and optional unit code, name, id or URL. Then: item or file with id. Cost: up to 20 rows by default. |
| `item` | One activity in full: due date, status, grade, marker feedback with rubric or marking-guide rows and feedback files, attached files, quiz attempts, or a forum's latest threads. Use when the user says "submission or item detail". Instead: file for binary content; attempt for quiz answers. Input: id, same-site URL, or UNIT TASK phrase. Then: file with a file id, or attempt with an attempt id. Cost: one item. |
| `attempt` | Each question with your response, and mark, correct answer and feedback when the site shows them. Use when the user says "a quiz attempt". Instead: item for the attempt list. Input: attempt id or review URL. Then: item with quiz_id. Cost: one attempt. |
| `grades` | Marked items; summary counts; all adds ungraded; feedback opt-in. Use when the user says "grades". Instead: item for rubrics. Input: unit; types: assign, quiz, h5pactivity. Then: offset; item id. Cost: 20 rows total. |
| `news` | Latest announcement threads with first-post text. Use when the user says "announcements". Instead: search_forums for other discussions. Input: optional unit code, name, id or URL. Then: thread with discussion id. Cost: up to 5 announcements by default. |
| `thread` | A discussion and a page of compact posts, with attachment links. Use when the user says "discussion posts". Instead: news for announcements. Input: discussion_id; offset and limit. Then: increase offset while posts_total exceeds returned. Cost: up to 20 posts by default. |
| `search_forums` | Matching posts with unit and forum name maps. Use when the user says "forum post text". Instead: find for activity names. Input: query, optional unit or courseId and forumId. Then: thread with discussion_id. Cost: bounded forum scan; total covers scanned scope. |
| `submit` | Upload local files into an assignment; returns the receipt Moodle shows afterwards. Use when the user says "upload assignment files". Instead: item for status only. Input: assignment id, same-site URL or UNIT TASK phrase; local file paths. Then: dry_run (default) only plans; show the plan to the person, then rerun with dry_run false; final submits for grading and cannot be undone; without a draft stage saving is the submission, so it is refused unless final is true. Cost: writes to Moodle. |
| `file` | One authenticated file: an image as image content, anything else as embedded binary, at most 16 MiB. Use when the user says "download a file". Instead: item for file choices. Input: id of a one-file activity, file or activity URL, or UNIT TASK phrase. Then: read the returned image or resource. Cost: binary content up to 16 MiB. |
| `messages` | Direct and group conversations with unread counts and the latest message. Use when the user says "messages". Instead: conversation for messages. Input: limit and offset. Then: conversation with id. Cost: 20 conversations. |
| `conversation` | A conversation's latest messages in chronological order; does not mark them read. Use when the user says "read a conversation". Instead: messages for conversation ids. Input: conversation_id, limit and offset (from newest). Then: increase offset for older messages. Cost: 50 messages by default. |
| `calendar` | All course, user and site calendar events in the date window. Use when the user says "calendar events". Instead: due for actionable deadlines. Input: days and optional unit. Then: item for an activity. Cost: one page plus one view per month. |

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
- `--json` forces JSON, `--pretty` indents it and `--yaml` writes YAML. Errors are `{ok:false,error:{code,message,hint},exit_code}` on stderr.
- `moodle commands --json` is the source of truth for the command tree.

## Setup

Sign in with `moodle doctor`; when a remote MCP session has expired, run `moodle mcp login`. `moodle mcp serve` starts the local stdio MCP server; `moodle mcp deploy` sets up a private remote one. See [setup](references/setup-and-auth.md).

## Commands

| Command | Description | Arguments | Options | Mutating |
| --- | --- | --- | --- | --- |
| `moodle due` | Items due in a date window. | [unit] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--days <number><br>--limit <number> | no |
| `moodle news` | Latest announcement threads with first-post text. | [unit] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number> | no |
| `moodle find` | Ranked sections, activities and discussion subjects. | <query> [unit] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--types <types> | no |
| `moodle attempt` | Each question with your response, and mark, correct answer and feedback when the site shows them. | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle update` | Update the package and redeploy the managed MCP Worker when either is behind. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--check<br>--quiet | yes |
| `moodle submit` | Upload local files into an assignment; returns the receipt Moodle shows afterwards. | <ref> [files...] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--final<br>--text <text><br>--text-file <path><br>--replace<br>--accept-statement | yes |
| `moodle submission` | Read or remove your assignment submission. |  |  | no |
| `moodle submission show` |  | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle submission remove` |  | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle quiz` | Take a quiz: start an attempt, answer questions, finish it. Beta. |  |  | no |
| `moodle quiz start` | Start a new attempt, or continue the one in progress, and show its first page. | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--password <password> | yes |
| `moodle quiz show` | Show one page of an attempt in progress: questions, options and saved answers. | <attempt> <quiz> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--page <n> | no |
| `moodle quiz answer` | Save an answer: choice letters (b or a,c) or text. | <attempt> <quiz> <question> [answer] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--from <file><br>--value <value> | yes |
| `moodle quiz finish` | Submit the attempt for grading. Moodle does not allow undoing this. | <attempt> <quiz> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle complete` | Mark an activity complete manually. | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--undo | no |
| `moodle open` | Open a unit or activity reference in the browser. | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle user` | Show authenticated user info. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle courses` | Inspect enrolled units. |  |  | no |
| `moodle courses list` | List enrolled units. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle courses show` | Show unit detail with sections. | <unit> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle todo` | List upcoming actionable timeline items. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--days <number> | no |
| `moodle alerts` | List notifications and message counts. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number> | no |
| `moodle alerts read` | Mark one notification, or all notifications, as read. | [notification] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--all | no |
| `moodle messages` | Read and send direct or group messages. |  |  | no |
| `moodle messages list` | Direct and group conversations with unread counts and the latest message. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--offset <number> | no |
| `moodle messages show` | A conversation's latest messages in chronological order; does not mark them read. | <conversation> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--offset <number> | no |
| `moodle messages send` | Send a message to a conversation id or user:ID. | <recipient> <text> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle messages read` | Mark one conversation, or all conversations, as read. | [conversation] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--all | no |
| `moodle calendar` | All course, user and site calendar events in the date window. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--days <number><br>--unit <unit><br>--ics | no |
| `moodle overview` | Show a compact multi-source overview. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--todo-limit <number><br>--todo-days <number><br>--alerts-limit <number> | no |
| `moodle activities` | Inspect activities. |  |  | no |
| `moodle activities list` | List activities in a unit; narrow by section. | <unit> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--section <section><br>--limit <number><br>--include-labels | no |
| `moodle activities show` | Show activity details, including the files moodle download would save. | <id> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle activities captions` | Export timestamped captions from an inline video label. | <id> [media] | --to <file><br>--pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle download` | Download files: one activity, a whole section, or a file URL. With no argument, browse. | [ref...] | --to <directory><br>--dest <path><br>--force<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle sync` | Keep one local folder per unit in step with Moodle: new files arrive, changed ones update, and a file you edited is never overwritten. | [unit] | --to <directory><br>--pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle grades` | Inspect grades. |  |  | no |
| `moodle grades list` | Show marked grades; request summary or all. | [unit] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--mode <mode><br>--types <types><br>--include-feedback<br>--include-ungraded<br>--limit <number><br>--offset <number><br>--graded-only | no |
| `moodle threads` | Inspect forum discussion threads. |  |  | no |
| `moodle threads show` | Show posts in a forum discussion. | <discussion> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--offset <number><br>--post <id><br>--body | no |
| `moodle threads reply` | Reply to a forum post. | <post> <text> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--attach <path> | no |
| `moodle forums` | Inspect forums. |  |  | no |
| `moodle forums show` | List discussions from a forum. | <forum> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--query <query> | no |
| `moodle forums post` | Create a forum discussion. | <forum> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--subject <subject><br>--text <text> | no |
| `moodle forums subscribe` | Subscribe to a forum. | <forum> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle forums unsubscribe` | Unsubscribe from a forum. | <forum> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle forums list` | List forum activities in a unit. | <unit> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number> | no |
| `moodle forums search` | Search forum discussion titles and post text. | <query> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--unit <unit><br>--course <course><br>--forum <forum><br>--titles-only<br>--unread-only<br>--recent<br>--limit-forums <number><br>--limit-discussions <number><br>--limit <number> | no |
| `moodle doctor` | Diagnose runtime, browser access, session, background jobs and MCP setup. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle coverage` | Check each command against this Moodle site with the signed-in session, one live read at a time. Nothing is created. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle completion` | Print shell completion for zsh, bash or fish. | <shell> |  | no |
| `moodle uninstall` | Remove local background jobs; optionally remove the selected Worker and configuration. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--remote<br>--purge | yes |
| `moodle auth` | Session and keepalive utilities. |  |  | no |
| `moodle auth status` | Show cached session freshness and keepalive state. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle auth site` | Find the Moodle site from any page address and save it; with no address, show the saved one. | [address] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle auth login` | Sign in through a browser the CLI controls, then capture the session. |  | --paste<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle auth keepalive` | Renew the Moodle session once; used by the background keepalive agent. |  | --no-renew<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle auth keepalive install` | Install a macOS launch agent that renews the session periodically. |  | --interval <minutes><br>--pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle auth keepalive uninstall` | Remove the keepalive launch agent. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle auth keepalive status` | Show whether the keepalive launch agent is installed. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle mcp` | Deploy a private MCP Worker on Cloudflare; encrypted session storage and local renewal. Free-tier limits apply. |  |  | no |
| `moodle mcp deploy` | Deploy or update the managed Moodle MCP server. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--dry-run<br>--repair<br>--rotate-key<br>--rotate-token<br>--rollback<br>--remote-login | yes |
| `moodle mcp status` | Show local and remote Moodle MCP readiness. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--verbose<br>--logs | no |
| `moodle mcp login` | Acquire and upload a fresh Moodle session. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle mcp connect` | Connect a supported MCP client. | [client] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--mode <mode><br>--show-token | yes |
| `moodle mcp clients` | List pending and approved OAuth clients. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle mcp revoke` | Revoke an OAuth client or all OAuth access. | [client-id] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--all | yes |
| `moodle mcp pair` | Open a pairing window so Claude can connect to the remote MCP server. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle mcp remove` | Remove one managed Moodle MCP deployment. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle mcp serve` | Run the local Moodle MCP server over stdio. |  | --stdio | no |
| `moodle mcp bridge` | Bridge a stdio MCP client to the managed remote server. |  | --profile <profile> | no |
| `moodle mcp renewal` | Run the installed managed-session renewal job. |  |  | no |
| `moodle mcp renewal run` | Check and renew one managed Moodle session. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--profile <profile> | no |
| `moodle mcp session` | Advanced managed-session operations. |  |  | no |
| `moodle mcp session push` | Upload a Moodle cookie from standard input. |  | --stdin<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle commands` | Describe the complete command tree. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle skills` | Show skill metadata or delegate to the shared skills CLI. |  |  | no |
| `moodle skills generate` | Regenerate the agent skill bundle from the CLI command tree. |  |  | no |
| `moodle skills add` | Install the published skill through npx skills add. |  |  | no |

## Errors

Errors are printed once on stderr. Exit codes: 0 success, 2 usage, 3 auth, 1 config, 4 not_found, 5 upstream, 1 network, 130 cancelled, 1 unexpected.
