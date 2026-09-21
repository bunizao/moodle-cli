# Command Reference

Generated from the live command tree. UNIT is a code/name, id or URL from `moodle units`.
`moodle UNIT SECTION` resolves a section; `moodle UNIT "TASK"` resolves an item.
Resources and folders return `files` with names and URLs. Pass a selected file URL to
`moodle get URL --to DIR`. Validate the receipt: path, byte count and content type.
`moodle download SOURCE --dest PATH --force` retains the exact-path replacement flow.
`moodle submit "UNIT TASK" FILE... --dry-run` shows the upload plan; without `--dry-run` it
asks for confirmation (`--yes` skips it) and prints the receipt Moodle shows afterwards.
`--final` also submits for grading, which Moodle does not let anyone undo.

| Command | Description | Arguments | Flags |
| --- | --- | --- | --- |
| moodle activities | Inspect activities. |  |  |
| moodle activities list | List activities in a unit; narrow by section. | <unit> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--section (value required)<br>--limit (value required)<br>--include-labels |
| moodle activities show | Show activity details; resource and folder files can be passed to moodle get or download. | <id> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle alerts | List notifications and message counts. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required) |
| moodle attempt | Each question with your response, and mark, correct answer and feedback when the site shows them. | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth | Session and keepalive utilities. |  |  |
| moodle auth keepalive | Renew the Moodle session once; used by the background keepalive agent. |  | --no-renew<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth keepalive install | Install a macOS launch agent that renews the session periodically. |  | --interval (value required)<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth keepalive status | Show whether the keepalive launch agent is installed. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth keepalive uninstall | Remove the keepalive launch agent. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth login | Sign in through a browser the CLI controls, then capture the session. |  | --paste<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle auth status | Show cached session freshness and keepalive state. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle commands | Describe the complete command tree. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle completion | Print shell completion for zsh, bash or fish. | <shell> |  |
| moodle doctor | Diagnose runtime, browser access, session, background jobs and MCP setup. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle download | Download one authenticated Moodle file. | <source> | --dest (value required)<br>--force<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle due | Items due in a date window. | [unit] | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--days (value required)<br>--limit (value required) |
| moodle find | Ranked sections, activities and discussion subjects. | <query> [unit] | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required)<br>--types (value required) |
| moodle forums | Inspect forums. |  |  |
| moodle forums list | List forum activities in a unit. | <unit> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required) |
| moodle forums search | Search forum discussion titles and post text. | <query> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--unit (value required)<br>--course (value required)<br>--forum (value required)<br>--titles-only<br>--unread-only<br>--recent<br>--limit-forums (value required)<br>--limit-discussions (value required)<br>--limit (value required) |
| moodle forums show | List discussions from a forum. | <forum> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required)<br>--query (value required) |
| moodle get | Download a resource by id, URL, or UNIT TASK phrase. | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--to (value required)<br>--force |
| moodle grades | Inspect grades. |  |  |
| moodle grades list | Show grade details for a unit. | [unit] | --graded-only<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle mcp | Deploy a private MCP Worker on Cloudflare; encrypted session storage and local renewal. Free-tier limits apply. |  |  |
| moodle mcp bridge | Bridge a stdio MCP client to the managed remote server. |  | --profile (value required) |
| moodle mcp clients | List pending and approved OAuth clients. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle mcp connect | Connect a supported MCP client. | [client] | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--mode (value required)<br>--show-token |
| moodle mcp deploy | Deploy or update the managed Moodle MCP server. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--dry-run<br>--repair<br>--rotate-key<br>--rotate-token<br>--rollback |
| moodle mcp login | Acquire and upload a fresh Moodle session. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle mcp pair | Open a pairing window so Claude can connect to the remote MCP server. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle mcp remove | Remove one managed Moodle MCP deployment. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle mcp renewal | Run the installed managed-session renewal job. |  |  |
| moodle mcp renewal run | Check and renew one managed Moodle session. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--profile (value required) |
| moodle mcp revoke | Revoke an OAuth client or all OAuth access. | [client-id] | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--all |
| moodle mcp serve | Run the local Moodle MCP server over stdio. |  | --stdio |
| moodle mcp session | Advanced managed-session operations. |  |  |
| moodle mcp session push | Upload a Moodle cookie from standard input. |  | --stdin<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle mcp status | Show local and remote Moodle MCP readiness. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--verbose<br>--logs |
| moodle news | Latest announcement threads with first-post text. | [unit] | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required) |
| moodle open | Open a unit or activity reference in the browser. | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle overview | Show a compact multi-source overview. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--todo-limit (value required)<br>--todo-days (value required)<br>--alerts-limit (value required) |
| moodle skills | Show skill metadata or delegate to the shared skills CLI. |  |  |
| moodle skills add | Install the published skill through npx skills add. |  |  |
| moodle skills generate | Regenerate the agent skill bundle from the CLI command tree. |  |  |
| moodle submit | Upload local files into an assignment; returns the receipt Moodle shows afterwards. | <ref> [files...] | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--final<br>--replace<br>--accept-statement |
| moodle threads | Inspect forum discussion threads. |  |  |
| moodle threads show | Show posts in a forum discussion. | <discussion> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required)<br>--offset (value required)<br>--post (value required)<br>--body |
| moodle todo | List upcoming actionable timeline items. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--limit (value required)<br>--days (value required) |
| moodle uninstall | Remove local background jobs; optionally remove the selected Worker and configuration. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--remote<br>--purge |
| moodle units | Inspect enrolled units. |  |  |
| moodle units list | List enrolled units. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle units show | Show unit detail with sections. | <unit> | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |
| moodle update | Update the package and redeploy the managed MCP Worker when either is behind. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required)<br>--check<br>--quiet |
| moodle user | Show authenticated user info. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields (value required) |

### Output Contract

- `--json` and piped output write compact JSON. `--pretty` indents it.
- `--yaml` writes YAML to stdout when supported.
- `--table` forces human-readable table/tree output.
- When stdout is not a TTY, commands default to JSON unless `--table` is set.
- `--fields a,b,c` keeps only listed top-level fields. Use envelope keys such as `units`, `due`, `item`, and `total`.
- Invalid `--fields` values are usage errors and list valid fields.
- Structured errors use `{ok:false,error:{code,message,hint},exit_code}` on stderr.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Network, configuration, or unexpected error |
| 2 | Usage error |
| 3 | Authentication error |
| 4 | Requested course, activity, forum, or discussion was not found |
| 5 | Moodle rejected a well-formed request |

MCP 0.8 discovers home, due, units, unit, find, item, grades, news, thread,
search_forums and file; a local server also lists submit, the only tool that writes.
Legacy names remain callable for one minor version and return
compact v2 envelopes. They are deprecated and omitted from default discovery.
Unit results contain a section index; supply section for activity details.
List activity URLs follow `{siteurl}/mod/{type}/view.php?id={id}`; use item for the actual URL.
File content is embedded in MCP resource blocks, limited to 16 MiB. CLI downloads stream to disk.
