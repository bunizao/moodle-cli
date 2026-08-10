# moodle-cli

**Give your AI agent access to Moodle.**

Let it keep up with deadlines and grades, fetch course files, and search forum discussions. `moodle-cli` finds your active browser session and keeps it alive in the background, so Moodle's login wall stays out of your way.

[![npm version](https://img.shields.io/npm/v/moodle-cli?logo=npm)](https://www.npmjs.com/package/moodle-cli)
[![CI](https://github.com/bunizao/moodle-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/moodle-cli/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-supported-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Quick links

- [Set up with your agent](#start-with-your-agent)
- [Install and sign in manually](#install-and-sign-in-manually)
- [Study Boooooooooost](#study-boooooooooost)
- [Connect web AI through a private MCP server](#remote-mcp-for-web-ai)
- [Developer and agent reference](#for-developers-and-agents)

## For users

### Start with your agent

Paste this into Codex, Claude Code, OpenClaw, Hermes Agent, or another agent that can use your terminal:

```text
Can you use https://github.com/bunizao/moodle-cli/raw/main/ONBOARDING.md to help me set up moodle-cli?
```

Your agent asks for your Moodle URL and opens your university's sign-in page when needed. Finish SSO in the browser while the agent waits; it verifies your account and sets up session renewal before reading Moodle. The same onboarding can deploy a private remote MCP server through your Cloudflare account.

### Install and sign in manually

Use Node.js 22+ or Bun:

```bash
# npm
npm install -g moodle-cli

# Bun
bun add --global moodle-cli

moodle --version
```

Run without a global install:

```bash
npx moodle-cli --help
bunx --bun moodle-cli --help
```

Sign in and open your dashboard:

```bash
moodle auth login
moodle overview
```

On first use, enter your Moodle site origin, such as `https://moodle.example.edu`. `moodle-cli` validates it and saves it to `~/.config/moodle-cli/config.yaml`. If the CLI cannot find an active session, it opens your university's sign-in page and waits for you to finish.

Keep the session active on macOS with `moodle auth keepalive install`. On Linux, schedule `moodle auth keepalive --json` every 30 minutes with cron.

GitHub Releases also provide standalone binaries for macOS arm64 and Linux x64.

### Study Boooooooooost

Ask your agent in plain language or run the matching command:

| Student request | CLI command |
| --- | --- |
| “Give me a quick Moodle dashboard.” | `moodle overview` |
| “What is due in the next 14 days?” | `moodle todo --days 14` |
| “Show my grades and feedback for FIT1045.” | `moodle grades FIT1045` |
| “Find forum posts about the exam in FIT1045.” | `moodle forums search "exam" --course FIT1045` |
| “Download the slides from this Moodle link.” | `moodle download '<Moodle URL>' --dest './slides.pdf'` |

Unit arguments accept a Moodle course ID or a unique course name.

#### Paste Moodle links directly

The CLI recognizes course, forum, assignment, quiz, resource, page, folder, and grade-report URLs:

```bash
moodle 'https://moodle.example.edu/course/view.php?id=34637'
moodle 'https://moodle.example.edu/mod/forum/discuss.php?d=9001#p9101'
moodle download 'https://moodle.example.edu/mod/resource/view.php?id=91234' --dest './Week 03/slides.pdf'
```

You can paste the same links into your agent and ask it to inspect the page, find related material, or download the file.

#### Download course files

`moodle download` accepts an activity ID or an authenticated Moodle URL. `--dest` sets the exact local path, and `--force` replaces an existing file after the download completes. Folder activities expose `file_entries` so you can choose which files to save.

### Remote MCP for web AI

A private remote MCP server lets a supported web AI client use Moodle when it cannot run the local CLI. You need a Cloudflare account.

```bash
moodle mcp deploy
moodle mcp status
```

`moodle mcp deploy` validates Moodle access, deploys a Cloudflare Worker, uploads an encrypted Moodle session, verifies readiness, and installs session renewal. The guided [`ONBOARDING.md`](ONBOARDING.md) asks whether you want this after local setup and helps connect your web AI client.

### Update

```bash
npm install -g moodle-cli@latest
bun add --global moodle-cli@latest
```

Standalone binaries print the latest GitHub Release URL instead of modifying themselves.

## For developers and agents

### Command and output contract

Inspect the full machine-readable command tree:

```bash
moodle commands --json
```

Commands support:

- `--json` or `--yaml` for structured output
- `--table` for human-readable output
- `--fields a,b,c` to select fields
- `-o, --output FILE` to write command output or a download receipt

The CLI prints tables in an interactive terminal and JSON when stdout goes to a pipe or file. Structured errors use one JSON object on stderr:

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

### MCP lifecycle and protocol

```bash
moodle mcp deploy
moodle mcp status
moodle mcp login
moodle mcp connect
moodle mcp remove
moodle mcp serve
moodle mcp bridge
```

The default client connection uses `moodle mcp bridge`, which keeps the Bearer token out of client configuration. Use `moodle mcp connect CLIENT --mode remote` for clients that support authenticated remote MCP headers.

Alpha version `0.7.0-alpha.2` supports MCP `2026-07-28` and a stateless compatibility lane for `2025-11-25` clients.

### Configuration

| Variable | Purpose |
| --- | --- |
| `MOODLE_BASE_URL` | Set the Moodle site origin without writing a config file. |
| `MOODLE_CONFIG` | Use another YAML config file. |
| `MOODLE_TOKEN` | Provide a `MoodleSession` cookie value in a non-browser environment. |
| `MOODLE_SESSION` | Compatibility alias for `MOODLE_TOKEN`. |

For local use, save `base_url` in `~/.config/moodle-cli/config.yaml`. `MOODLE_URL` remains a deprecated fallback for `MOODLE_BASE_URL`.

### Build from source

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

## License

[MIT](LICENSE)
