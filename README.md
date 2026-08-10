# moodle-cli

Give your AI agent access to Moodle so it can track deadlines, check grades, download course files, and search forum discussions for you. `moodle-cli` finds your active browser session and renews it in the background, keeping Moodle's login wall out of your way.

[![npm version](https://img.shields.io/npm/v/moodle-cli?logo=npm)](https://www.npmjs.com/package/moodle-cli)
[![CI](https://github.com/bunizao/moodle-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/moodle-cli/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-supported-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Start with your agent

Paste this into Codex, Claude Code, OpenClaw, Hermes agent, or other AI agents of yours:

```text
Can you use https://github.com/bunizao/moodle-cli/raw/main/ONBOARDING.md to help me set up moodle-cli?
```

## Install Manually

Use Node.js 22 or newer:

```bash
npm install -g moodle-cli
moodle --version
```

Or install with Bun:

```bash
bun add --global moodle-cli
moodle --version
```

Or run one command without a global install:

```bash
npx moodle-cli --help
bunx --bun moodle-cli --help
```

GitHub Releases also provide standalone binaries for macOS arm64 and Linux x64.

## Sign in

Run:

```bash
moodle auth login
moodle user
moodle overview
```

On the first command, `moodle-cli` asks for your Moodle site root, validates it, and saves it to `~/.config/moodle-cli/config.yaml`:

```yaml
base_url: https://moodle.example.edu
```

Enter the site origin only. Leave out paths such as `/login/index.php`, `/my/`, or `/course/view.php?id=123`. If you only have a long Moodle link, give it to your coding agent with the setup prompt above.

`moodle auth login` checks your local session cache, supported browsers, and `okta-auth-cli`. It opens Moodle in your browser when you need to complete SSO or OAuth sign-in.

## Use it for study

Ask your agent in plain language, or run the matching command yourself:

| Student request | CLI command |
| --- | --- |
| “Give me a quick Moodle dashboard.” | `moodle overview` |
| “What is due in the next 14 days?” | `moodle todo --days 14` |
| “Show my grades and feedback for FIT1045.” | `moodle grades FIT1045` |
| “Find forum posts about the exam in FIT1045.” | `moodle forums search "exam" --course FIT1045` |
| “Download the slides from this Moodle link.” | `moodle download '<Moodle URL>' --dest './slides.pdf'` |

Agents receive JSON when they pipe command output, which makes it easy to turn Moodle data into a checklist, study plan, or concise summary.

### Paste Moodle links directly

The CLI recognizes course, forum, assignment, quiz, resource, page, folder, and grade-report URLs:

```bash
moodle 'https://moodle.example.edu/course/view.php?id=34637'
moodle 'https://moodle.example.edu/mod/forum/discuss.php?d=9001#p9101'
moodle download 'https://moodle.example.edu/mod/resource/view.php?id=91234' --dest './Week 03/slides.pdf'
```

This also works in conversation: paste a Moodle link into your agent and ask it to inspect the page, find related material, or download the file.

## Common commands

```bash
moodle overview
moodle alerts
moodle todo --days 7
moodle units
moodle units show FIT1045
moodle activities FIT1045
moodle activities show 91234
moodle grades FIT1045
moodle forums FIT1045
moodle forums search 'assignment 2' --course FIT1045
moodle threads show 9001
moodle download 91234 --dest './slides.pdf'
moodle auth status
moodle --help
```

Unit arguments accept a Moodle course ID or a unique course name.

## Use it with agents

Install the bundled skill so Codex, Claude Code, and compatible agents know the command model and safe authentication flow:

```bash
moodle skills add
```

Direct install commands:

```bash
npx skills add https://github.com/bunizao/moodle-cli
bunx --bun skills add https://github.com/bunizao/moodle-cli
```

Agents can inspect the full command tree with `moodle commands --json`. The generated [`SKILL.md`](SKILL.md) routes them to focused setup, coursework, forum, download, and maintenance guidance under [`references/`](references/).

### Private remote MCP

Deploy a private Moodle MCP server when your agent cannot run the local CLI:

```bash
moodle mcp deploy
```

The command validates Moodle access, deploys a Cloudflare Worker, uploads an encrypted session, verifies readiness, installs local session renewal, and connects detected Codex, Claude, VS Code, and Cursor clients.

Manage it with:

```bash
moodle mcp status
moodle mcp login
moodle mcp connect
moodle mcp remove
```

The default connection uses `moodle mcp bridge`, which keeps the Bearer token out of client configuration. Use `moodle mcp connect CLIENT --mode remote` for clients that support authenticated remote MCP headers.

Alpha version `0.7.0-alpha.0` supports MCP `2026-07-28` and a stateless compatibility lane for `2025-11-25` clients.

## Keep your session active

Moodle can expire idle sessions. Renew once or install background renewal:

```bash
moodle auth status
moodle auth keepalive
moodle auth keepalive install   # macOS, every 30 minutes
```

On Linux, schedule `moodle auth keepalive --json` with cron.

## Download files

Download by activity ID or authenticated Moodle URL:

```bash
moodle download 91234
moodle download 'https://moodle.example.edu/mod/resource/view.php?id=91234' --dest './Course/Week 03/slides.pdf'
moodle dl 'https://moodle.example.edu/pluginfile.php/123/mod_resource/content/1/slides.pdf'
```

`--dest` sets the exact local path. The command refuses to overwrite an existing file unless you pass `--force`. Folder activities expose `file_entries`; choose an entry and download each file you need.

## Output for scripts and agents

Commands support:

- `--json` or `--yaml` for structured output
- `--table` for human-readable output
- `--fields a,b,c` to select fields
- `-o, --output FILE` to write command output or a download receipt

The CLI prints tables in an interactive terminal and JSON when stdout goes to a pipe or file.

Errors use stable exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Network, configuration, or unexpected error |
| 2 | Usage error |
| 3 | Authentication error |
| 4 | Course, activity, forum, or discussion not found |
| 5 | Moodle rejected the request |

With JSON output, stderr contains one parseable error object:

```json
{"ok":false,"error":{"code":"auth","message":"...","hint":"..."},"exit_code":3}
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `MOODLE_BASE_URL` | Set the Moodle site origin without writing a config file. |
| `MOODLE_CONFIG` | Use another YAML config file. |
| `MOODLE_TOKEN` | Provide a `MoodleSession` cookie value for non-browser environments. |
| `MOODLE_SESSION` | Compatibility alias for `MOODLE_TOKEN`. |

For local use, the saved `base_url` usually works better than an environment variable. If you do not know your site origin, tell your agent: “Use this Moodle page URL, find and verify the Moodle site origin, then add it to my moodle-cli config.”

`MOODLE_URL` remains a deprecated fallback for `MOODLE_BASE_URL`.

## Update

```bash
npm install -g moodle-cli@latest
bun add --global moodle-cli@latest
```

Standalone binaries print the latest GitHub Release URL instead of modifying themselves.

## License

[MIT](LICENSE)
