# moodle commands

Generated from `moodle commands --json` for version 0.11.1.

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
| `moodle complete` | Mark an activity complete manually. | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--undo | yes |
| `moodle open` | Open a unit or activity reference in the browser. | <ref> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle user` | Show authenticated user info. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle courses` | Inspect enrolled units. |  |  | no |
| `moodle courses list` | List enrolled units. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle courses show` | Show unit detail with sections. | <unit> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle todo` | List upcoming actionable timeline items. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--days <number> | no |
| `moodle alerts` | List notifications and message counts. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number> | no |
| `moodle alerts read` | Mark one notification, or all notifications, as read. | [notification] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--all | yes |
| `moodle messages` | Read and send direct or group messages. |  |  | no |
| `moodle messages list` | Direct and group conversations with unread counts and the latest message. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--offset <number> | no |
| `moodle messages show` | A conversation's latest messages in chronological order; does not mark them read. | <conversation> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--offset <number> | no |
| `moodle messages send` | Send a message to a conversation id or user:ID. | <recipient> <text> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle messages read` | Mark one conversation, or all conversations, as read. | [conversation] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--all | yes |
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
| `moodle threads reply` | Reply to a forum post. | <post> <text> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--attach <path> | yes |
| `moodle forums` | Inspect forums. |  |  | no |
| `moodle forums show` | List discussions from a forum. | <forum> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number><br>--query <query> | no |
| `moodle forums post` | Create a forum discussion. | <forum> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--subject <subject><br>--text <text> | yes |
| `moodle forums subscribe` | Subscribe to a forum. | <forum> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle forums unsubscribe` | Unsubscribe from a forum. | <forum> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | yes |
| `moodle forums list` | List forum activities in a unit. | <unit> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--limit <number> | no |
| `moodle forums search` | Search forum discussion titles and post text. | <query> | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--unit <unit><br>--course <course><br>--forum <forum><br>--titles-only<br>--unread-only<br>--recent<br>--limit-forums <number><br>--limit-discussions <number><br>--limit <number> | no |
| `moodle doctor` | Diagnose runtime, browser access, session, background jobs and MCP setup. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle coverage` | Check each command against this Moodle site with the signed-in session, one live read at a time. Nothing is created. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle completion` | Print shell completion for zsh, bash or fish. | <shell> |  | no |
| `moodle uninstall` | Remove local background jobs; optionally remove the selected Worker and configuration. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields><br>--remote<br>--purge | yes |
| `moodle auth` | Session and keepalive utilities. |  |  | no |
| `moodle auth status` | Show cached session freshness and keepalive state. |  | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle auth site` | Find the Moodle site from any page address and save it; with no address, show the saved one. | [address] | --pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
| `moodle auth login` | Sign in through a browser the CLI controls, then capture the session. |  | --paste<br>--pretty<br>--json<br>--yaml<br>--table<br>--fields <fields> | no |
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

## Exit codes

With `--json`, a failure is one `{ ok: false, error: { code, message, hint } }` object on stderr.

| Exit | Error code |
| --- | --- |
| 0 | success |
| 2 | usage |
| 3 | auth |
| 1 | config |
| 4 | not_found |
| 5 | upstream |
| 1 | network |
| 130 | cancelled |
| 1 | unexpected |
