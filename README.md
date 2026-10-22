<p align="center"><a href="https://unicorn.tuuhub.com"><img src=".github/assets/hero.jpg" alt="moodle-cli: Moodle from your terminal, scripts and AI agent, part of unicorn" width="100%"></a></p>

# moodle-cli

**Give your AI agent access to Moodle.**

Let it keep up with deadlines and grades, fetch course files, and search forum discussions. `moodle-cli` finds your active browser session and keeps it alive in the background, so Moodle's login wall stays out of your way. One package, three ways in: a CLI, a local MCP server, and a private **remote MCP server** on your own Cloudflare account for Claude, ChatGPT and other web AI.

[![npm version](https://img.shields.io/npm/v/moodle-cli?logo=npm)](https://www.npmjs.com/package/moodle-cli)
[![CI](https://github.com/bunizao/moodle-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/moodle-cli/actions/workflows/ci.yml)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-supported-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 🦄 **Part of [unicorn](https://unicorn.tuuhub.com).** Live tools answer what is there now; unicorn answers what changed.
>
> 📖 **[Read the docs → unicorn.tuuhub.com/docs/moodle](https://unicorn.tuuhub.com/docs/moodle)**

| Use it from | How |
| --- | --- |
| Claude, ChatGPT or any web AI | `moodle mcp deploy`, then add your Worker as a custom connector ([remote MCP](#remote-mcp)) |
| Claude Code, Codex or another local agent | `moodle mcp serve` ([local MCP](#local-mcp)), `moodle mcp connect` for your Worker, or the CLI plus its [agent skill](#agent-skill) |
| Your terminal and scripts | `npm install -g moodle-cli` ([quick start](#quick-start)) |

## Quick start

Let your agent do it (Codex, Claude Code, OpenClaw, Hermes Agent, or any agent with terminal access):

```text
Can you use https://github.com/bunizao/moodle-cli/raw/main/ONBOARDING.md to help me set up moodle-cli?
```

It asks for your Moodle URL, opens your university's sign-in page when needed, sets up session renewal, and can deploy the remote MCP server too.

Or by hand, on macOS arm64 or Linux x64:

```bash
curl -fsSL https://raw.githubusercontent.com/bunizao/moodle-cli/main/install.sh | sh
moodle doctor
moodle auth login
moodle
```

## Quick links

- [Install and sign in](#install-and-sign-in)
- [Study Boooooooooost](#study-boooooooooost)
- [Remote and local MCP](#mcp-servers)
- [Developer and agent reference](#for-developers-and-agents)
- [Contributing](#contributing)

## Install and sign in

### Install

```bash
# Standalone binary with its own runtime (macOS arm64, Linux x64)
curl -fsSL https://raw.githubusercontent.com/bunizao/moodle-cli/main/install.sh | sh

# npm (Node.js 22.13+) or Bun
npm install -g moodle-cli
bun add --global moodle-cli

# No global install
npx moodle-cli --help
bunx --bun moodle-cli --help
```

GitHub Releases also provide standalone binaries for macOS arm64 and Linux x64.

### Sign in

```bash
moodle auth login
moodle
```

On first use, paste the address of any Moodle page: the front page, your dashboard, or a course. `moodle-cli` asks the site for its own address (including a path such as `/moodle`) and saves it to `~/.config/moodle-cli/config.yaml`; `moodle auth site <address>` changes it later. With no active session, the CLI opens your university's sign-in page and waits.

On macOS the browser cookie store sits behind Full Disk Access for your terminal app. If `moodle doctor` says the store cannot be opened, grant that access and restart the terminal, or hand the cookie over once with `moodle auth login --paste` (not echoed, kept in the encrypted session cache). `Copy as cURL` on any request in the browser's Network tab carries it, as does the `MoodleSession` cookie value.

Keep the session alive with `moodle auth keepalive install` on macOS, or `moodle auth keepalive --json` from cron every 30 minutes on Linux.

### Update

```bash
moodle update
moodle update --check
```

`moodle update` upgrades through whichever installer put it there and redeploys your Worker when it is behind. The CLI checks npm once a day and prints a one-line notice when a newer release exists; `MOODLE_NO_UPDATE_CHECK=1` turns that off. Details: [docs/reference.md](docs/reference.md#update).

## Study Boooooooooost

Ask your agent in plain language or run the matching command:

| Student request | CLI command |
| --- | --- |
| “Give me a quick Moodle dashboard.” | `moodle` |
| “What is due in the next 14 days?” | `moodle due --days 14` |
| “Show my grades and feedback for UNIT.” | `moodle grades UNIT --mode graded --include-feedback` |
| “Find forum posts about the exam in UNIT.” | `moodle forums search "exam" --course UNIT` |
| “Download the slides from this Moodle link.” | `moodle download '<Moodle URL>' --dest './slides.pdf'` |

Unit arguments accept the site's code or name, an id or URL. No code format is assumed.

```bash
moodle UNIT
moodle UNIT 7
moodle UNIT "TASK"
moodle find "week 7 slides" UNIT
moodle dl "UNIT week 7 slides" --to ./downloads
moodle grades
moodle news UNIT
```

`moodle grades [UNIT]` returns marked items. Use `--mode summary` for per-unit counts and course totals or `--mode all` to add ungraded items, with `--types assign,quiz` to filter by Moodle module type (`assignment` is accepted as `assign`). Feedback is omitted unless `--include-feedback` is set. Details return at most 20 rows across units; `--limit` and `--offset` page through the filtered results. MCP uses the same options with underscores (`include_feedback`, `include_ungraded`); `--graded-only` remains an alias for graded mode.

Ambiguous references list candidates. JSON callers receive `error.code: "ambiguous"`. At a terminal you pick the match from a list (arrow keys, or type to filter a long one). A bare number in a section reference matches that number in the site's section name, so 7 never matches 17.

### Paste Moodle links directly

The CLI recognizes course, forum, assignment, quiz, resource, page, folder, and grade-report URLs:

```bash
moodle 'https://moodle.example.edu/course/view.php?id=34637'
moodle 'https://moodle.example.edu/mod/forum/discuss.php?d=9001#p9101'
moodle download 'https://moodle.example.edu/mod/resource/view.php?id=91234' --dest './Week 03/slides.pdf'
```

You can paste the same links into your agent and ask it to inspect the page, find related material, or download the file.

### Embedded lecture videos

Inline Moodle labels stay out of the compact section view. Include them when looking for a video, then inspect the label for its media title and viewer URL:

```bash
moodle activities list UNIT --section 'Week 12' --include-labels --json
moodle activities show LABEL_ID --json
moodle activities captions LABEL_ID --to ./lecture-captions.txt
```

`activities captions` saves timestamped SRT or VTT text with the video ID and source URL. If a label has several videos, pass the media ID or its 1-based position after `LABEL_ID`. Panopto captions require a signed-in Panopto browser session whose cookies the CLI can read; sign in through the viewer URL shown by `activities show` first. A recording with no captions, an expired Panopto session, or a response that is not caption text creates no file. The command does not overwrite an existing file.

### Download course files

`moodle download` (alias `dl`) saves what the web page offers:

- one activity: a resource, every file in a folder, or an assignment's attached files (brief, datasets);
- a whole section: `moodle dl "UNIT week 5"` or a section URL such as `…/course/view.php?id=34637&section=5`, including child sections the page shows inside it;
- a single `pluginfile.php` link.

With no argument at a terminal, it walks unit → section → item the way the course page does: type to filter, Escape to go back a step. `moodle dl UNIT` starts at that unit's sections. Files land in the current directory or `--to DIR` (created when missing). A file already there is skipped, so rerunning a section after Ctrl+C or a dropped connection fetches only what is missing; `--force` downloads everything again. The same document linked twice is saved once, and two different files with one name get a ` (2)` suffix. `--dest` names the file when there is exactly one. Quote URLs in zsh, whose `?` is a glob.

### Keep units in sync

`moodle sync` keeps one folder per unit in step with Moodle: resources, folder contents and assignment attachments, laid out by section. Pages and books are saved as single HTML files with their images embedded, so they read the same offline.

```bash
moodle sync --to ~/Units              # every unit, one subfolder each
moodle sync UNIT --to ~/Units         # just one
moodle sync --dry-run                 # what would change, nothing written
```

Each unit folder holds a `.moodle-sync.json` manifest, so a rerun asks Moodle only whether each file changed and usually downloads nothing. A changed file replaces your copy only when you have not edited it; an edited copy stays put and the new version lands beside it as `name (updated YYYY-MM-DD).ext`. Files removed from Moodle are reported and kept locally, and a file you delete stays deleted until Moodle changes it. Rename or move a unit folder freely: the manifest, not the folder name, says which unit it holds.

### Submit assignment files

`moodle submit` uploads local files into an assignment through the same pages a browser
uses, then prints the receipt Moodle shows afterwards: status, files, due date and the
time it was checked. It is the only command that writes to Moodle.

```bash
moodle submit "UNIT TASK" essay.pdf --dry-run          # plan only: limits, statement, existing files
moodle submit "UNIT TASK" essay.pdf                    # upload as a draft; refused if the assignment has no draft stage
moodle submit "UNIT TASK" --final --accept-statement   # submit the draft for grading (cannot be undone)
```

Every run plans first and asks for confirmation; `--yes` skips the prompt for scripts.
`--replace` removes the files already in the submission, `--accept-statement` agrees to
the site's submission statement when one is required, and a file that is too large or of
the wrong type is refused before anything is uploaded. Some assignments have no draft
stage, so saving the files is the submission for grading; without `--final`, `submit`
refuses those (and any assignment whose pages do not show which kind it is) before
uploading anything. The plan reports `draft_stage`. `--replace` with no files is refused
rather than emptying the submission. In a group submission the plan names the `group`:
its files are shared, so an upload or `--replace` changes everyone's submission. When every
member has to submit, the receipt lists who Moodle is still `awaiting`.

### Take a quiz (beta)

`moodle quiz` starts an attempt, saves answers and submits it, replaying the forms a browser posts. It is beta: a Moodle update can break it, and it is deliberately CLI-only, never offered over MCP.

```bash
moodle quiz start UNIT "Practice quiz"        # or a quiz id or URL; resumes an attempt in progress
moodle quiz show <attempt> <quiz> --page 2
moodle quiz answer <attempt> <quiz> 1 b         # option letter, or "a,c" for several
moodle quiz answer <attempt> <quiz> 3 --from essay.md
moodle quiz finish <attempt> <quiz>             # "Submit all and finish"; Moodle does not allow undoing this
```

Before `quiz start` asks, it names the time limit (the timer starts at once and does not pause) and how many attempts are left. A quiz that moves forward only is refused an earlier page, and `quiz show --page` asks before opening the next page, because that locks the current one. Every write shows the beta and academic-integrity notice and asks for a yes; a pipe must pass `--yes`, and `--dry-run` shows the plan. Answers you send are your own submission under your institution's rules: use it only where the quiz allows it, and check the attempt in a browser before you finish. A quiz with an access password asks for it at the terminal (not echoed, never stored); scripts pass `--password`. A quiz that requires the Safe Exam Browser cannot be taken here, because Moodle checks the browser itself. Question types without a plain choice or text input are shown but must be answered in a browser.

## MCP servers

### Remote MCP

A private remote MCP server lets Claude, ChatGPT and other web AI use Moodle without running the CLI. It runs on your own Cloudflare account and is pinned to your Moodle account.

```bash
moodle mcp deploy
moodle mcp status
moodle mcp pair      # connect claude.ai: prints the connector URL and a one-time code
```

`moodle mcp deploy` checks Moodle access, deploys the Worker, uploads an encrypted session, verifies it, and installs session renewal. Add the printed URL as a custom connector; claude.ai signs in through OAuth with the pairing code or **Sign in with Moodle**. For Codex, Claude Code, Cursor or VS Code, `moodle mcp connect CLIENT` points the client at your Worker through `moodle mcp bridge`, which keeps the Bearer token out of its config. No local browser? `moodle mcp deploy --remote-login --yes` does it from a cloud sandbox.

The remote server is read-only. `get_file` returns files up to 16 MiB as embedded MCP resources, so clients never need an authenticated Moodle URL.

Everything else (every `moodle mcp` command, claude.ai pairing, browserless setup, mobile-token renewal, revoking and rotating credentials) is in [docs/remote-mcp.md](docs/remote-mcp.md).

### Local MCP

```bash
moodle mcp serve
```

A stdio server for Claude Code, Codex, Cursor or VS Code, using the CLI's own session. It adds `submit`, which needs the files on the same machine. It defaults to `dry_run: true`, so an agent must show the plan and run again with `dry_run: false`; `final: true` submits for grading.

### Check your site

```bash
moodle coverage
```

Moodle sites differ in web services, themes, languages and course formats. `moodle coverage` runs each read-only command once against your own units and checks every answer against what the site states elsewhere. `moodle coverage --json` holds no names or unit titles, so attach it to an issue when your school's Moodle misbehaves. How each outcome is decided: [docs/reference.md](docs/reference.md#check-your-site).

## For developers and agents

### Command and output contract

Inspect the full machine-readable command tree:

```bash
moodle commands --json
```

Commands support:

- `--json` or `--yaml` for structured output; `--pretty` indents JSON
- `--table` for human-readable output
- `--fields units,total` to select envelope fields
- `-o, --output FILE` to write command output or a download receipt

The CLI prints tables in an interactive terminal and JSON when stdout goes to a pipe or file. In a terminal, a command missing its unit asks for it with a picker (`moodle activities` lists your units); pipes, `--json` and agent shells get the usage error with the usage line instead. Structured errors use one JSON object on stderr:

```json
{"ok":false,"error":{"code":"auth","message":"...","hint":"..."},"exit_code":3}
```

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Network, configuration, or unexpected error |
| 2 | Usage error |
| 3 | Authentication error |
| 4 | Course, activity, forum, or discussion not found |
| 5 | Moodle rejected the request |

### Agent skill

Install the generated skill bundle:

```bash
moodle skills add

# Direct alternatives
npx skills add https://github.com/bunizao/moodle-cli
bunx --bun skills add https://github.com/bunizao/moodle-cli
```

[`SKILL.md`](SKILL.md) routes agents to focused setup, coursework, forum, download, and maintenance guidance under [`references/`](references/).

### Configuration

| Variable | Purpose |
| --- | --- |
| `MOODLE_BASE_URL` | Set the Moodle site address, with its path if it has one, without writing a config file. |
| `MOODLE_CONFIG` | Use another YAML config file. |
| `MOODLE_TOKEN` | Provide a `MoodleSession` cookie value in a non-browser environment. |
| `MOODLE_SESSION` | Compatibility alias for `MOODLE_TOKEN`. |

For local use, save `base_url` in `~/.config/moodle-cli/config.yaml`. `MOODLE_URL` remains a deprecated fallback for `MOODLE_BASE_URL`.

### Build from source

The [development guide](docs/development.md) covers the code layout, test lanes, scripts, the Moodle lab and releases.

Node.js workflow:

```bash
npm ci
npm run check
npm test
npm run build
npm run pack:check
```

Bun workflow:

```bash
bun install
bunx tsc --noEmit
bunx vitest run
bun run build
bun run pack:check
```

What an install leaves behind, `moodle uninstall`, and the structured output envelopes: [docs/reference.md](docs/reference.md).

## Contributing

Bug reports from real Moodle sites help most: run `moodle coverage --json` and attach the output. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md) for vulnerabilities. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## 🦄 Part of unicorn

unicorn is one project in two layers. The live tools answer what is there now; unicorn answers what changed.

| Project | Layer | What it does |
| --- | --- | --- |
| [🦄 unicorn](https://github.com/TuuHub/unicorn) | Memory | A Cloudflare Worker on your own account. Reads Moodle, Ed, Canvas, Gmail and feeds every hour, remembers what each said, and tells your AI agent what changed. Remote MCP. |
| **[moodle-cli](https://github.com/bunizao/moodle-cli)** (you are here) | **Live** | **Moodle: units, deadlines, grades, forums, files, submissions. CLI, local and remote MCP.** |
| [edstem-cli](https://github.com/bunizao/edstem-cli) | Live | Ed Discussion: units, threads, lessons, files, posting. CLI, local and remote MCP. |
| [ontrack](https://github.com/bunizao/ontrack-cli) | Live | OnTrack / Doubtfire: units, tasks, chats, submissions. CLI only. |

The three CLIs share one command contract through [@bunizao/cli-kit](https://github.com/bunizao/cli-kit).

📖 **Docs:** [this project](https://unicorn.tuuhub.com/docs/moodle) · [all projects](https://unicorn.tuuhub.com/docs) · [CLIs overview](https://unicorn.tuuhub.com/cli) · [MCP clients](https://unicorn.tuuhub.com/docs/mcp)

## License

[MIT](LICENSE). You may use, copy, modify and redistribute this code, including in your own and commercial projects, without asking. Keep the copyright notice and the license text with any copy or substantial portion of it. A link back to this repository is appreciated but not required.
