# Command Reference

Read this file for exact arguments, flags, and defaults after selecting a branch from `SKILL.md`.

| Command | Description | Arguments | Flags |
| --- | --- | --- | --- |
| moodle activities | Inspect activities. |  |  |
| moodle activities list | List activities in a unit. | <unit> | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle activities show | Show activity detail. | <id> | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle alerts | List notifications and message counts. |  | --json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required) |
| moodle auth | Session and keepalive utilities. |  |  |
| moodle auth keepalive | Renew the Moodle session once; used by the background keepalive agent. |  | --no-renew<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth keepalive install | Install a macOS launch agent that renews the session periodically. |  | --interval (value required)<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth keepalive status | Show whether the keepalive launch agent is installed. |  | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth keepalive uninstall | Remove the keepalive launch agent. |  | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth login | Extract a fresh session, opening the browser when needed. |  | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth status | Show cached session freshness and keepalive state. |  | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle commands | Describe the complete command tree. |  | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle forums | Inspect forums. |  |  |
| moodle forums list | List forum activities in a unit. | <unit> | --json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required) |
| moodle forums search | Search forum discussion titles and post text. | <query> | --json<br>--yaml<br>--table<br>--fields (value required)<br>--course (value required)<br>--forum (value required)<br>--titles-only<br>--unread-only<br>--recent<br>--limit-forums (value required)<br>--limit-discussions (value required)<br>--limit (value required) |
| moodle forums show | List discussions from a forum. | <forum> | --json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required)<br>--query (value required) |
| moodle grades | Inspect grades. |  |  |
| moodle grades list | Show grade details for a unit. | <unit> | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle overview | Show a compact multi-source overview. |  | --json<br>--yaml<br>--table<br>--fields (value required)<br>--todo-limit (value required)<br>--todo-days (value required)<br>--alerts-limit (value required) |
| moodle skills | Show skill metadata or delegate to the shared skills CLI. |  |  |
| moodle skills add | Install the published skill through npx skills add. |  |  |
| moodle skills generate | Regenerate the agent skill bundle from the CLI command tree. |  |  |
| moodle threads | Inspect forum discussion threads. |  |  |
| moodle threads show | Show posts in a forum discussion. | <discussion> | --json<br>--yaml<br>--table<br>--fields (value required)<br>--post (value required)<br>--body |
| moodle todo | List upcoming actionable timeline items. |  | --json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required)<br>--days (value required) |
| moodle units | Inspect enrolled units. |  |  |
| moodle units list | List enrolled units. |  | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle units show | Show unit detail with sections. | <unit> | --json<br>--yaml<br>--table<br>--fields (value required) |
| moodle user | Show authenticated user info. |  | --json<br>--yaml<br>--table<br>--fields (value required) |
