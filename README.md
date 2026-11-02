<p align="center"><a href="https://unicorn.tuuhub.com"><img src=".github/assets/hero.jpg" alt="moodle-cli: Moodle from your terminal, scripts and AI agent, part of unicorn" width="100%"></a></p>

# moodle-cli

**Give your AI agent access to Moodle.**

Keep up with deadlines and grades, fetch course files, and search forums. It reuses your browser session and keeps it alive, so the login wall stays out of your way.

Use it as a CLI, a local MCP server, or a private remote MCP server on your own Cloudflare account.

[![npm version](https://img.shields.io/npm/v/moodle-cli?logo=npm)](https://www.npmjs.com/package/moodle-cli)
[![CI](https://github.com/bunizao/moodle-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/moodle-cli/actions/workflows/ci.yml)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-supported-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 🦄 Part of [unicorn](https://unicorn.tuuhub.com). Live tools answer what is there now; unicorn answers what changed.
>
> 📖 **[Read the docs](https://unicorn.tuuhub.com/docs/moodle)**

## Set up

Ask your agent (Claude Code, Codex, OpenClaw, or anything with a terminal):

```text
Read https://unicorn.tuuhub.com/docs/moodle/agent-setup.md and set up moodle-cli for me.
```

It asks for your Moodle address and waits while you finish university sign-in in the browser. It can also deploy the remote MCP server for you.

Or by hand, on macOS arm64 or Linux x64:

```bash
curl -fsSL https://raw.githubusercontent.com/bunizao/moodle-cli/main/install.sh | sh
moodle auth login
moodle
```

Elsewhere, use `npm install -g moodle-cli` or `bun add --global moodle-cli`.

## Use it from

| Where | How |
| --- | --- |
| Claude, ChatGPT or any web AI | `moodle mcp deploy`, then add your Worker as a custom connector. [Remote MCP](https://unicorn.tuuhub.com/docs/moodle/mcp-server) |
| Claude Code, Codex, Cursor | `moodle mcp serve`, or install the agent skill with `moodle skills add`. |
| Your terminal and scripts | `moodle` prints tables in a terminal and JSON in a pipe. [Scripting](https://unicorn.tuuhub.com/docs/developers/moodle) |

## Study Boooooooooost

Ask in plain language, or run the command yourself:

| Ask your agent | Command |
| --- | --- |
| “Give me a quick Moodle dashboard.” | `moodle` |
| “What is due in the next 14 days?” | `moodle due --days 14` |
| “Show my grades and feedback for UNIT.” | `moodle grades UNIT --include-feedback` |
| “Find forum posts about the exam.” | `moodle forums search "exam" --course UNIT` |
| “Download week 7's slides.” | `moodle dl "UNIT week 7 slides"` |
| “Keep a copy of all my units.” | `moodle sync --to ~/Units` |
| “Submit my essay as a draft.” | `moodle submit "UNIT TASK" essay.pdf` |

`UNIT` is the unit's code, name, id or URL as your site shows it. You can paste Moodle links straight in. Submitting always shows a plan and asks first.

## Learn more

- [Install](https://unicorn.tuuhub.com/docs/moodle/install) and [sign in](https://unicorn.tuuhub.com/docs/moodle/sign-in)
- [Daily use](https://unicorn.tuuhub.com/docs/moodle/daily-use)
- [Grades and deadlines](https://unicorn.tuuhub.com/docs/moodle/grades-and-deadlines)
- [Forums](https://unicorn.tuuhub.com/docs/moodle/forums)
- [Downloads and sync](https://unicorn.tuuhub.com/docs/moodle/downloads)
- [Submitting](https://unicorn.tuuhub.com/docs/moodle/submit) and [quizzes (beta)](https://unicorn.tuuhub.com/docs/moodle/quiz)
- [MCP server](https://unicorn.tuuhub.com/docs/moodle/mcp-server): private remote, claude.ai, local
- [Configuration](https://unicorn.tuuhub.com/docs/moodle/configuration)
- [Troubleshooting](https://unicorn.tuuhub.com/docs/moodle/troubleshooting) and [uninstalling](https://unicorn.tuuhub.com/docs/moodle/uninstall)
- [Command reference](https://unicorn.tuuhub.com/docs/moodle/reference)

## Embedding in another Worker

A Cloudflare Worker you already run can serve Moodle MCP under a path, so nobody deploys a second Worker. Import `moodle-cli/worker`:

```ts
import { createMoodleHandler, callMoodleTool, type MoodleWorkerEnv } from "moodle-cli/worker";
export { SessionBroker, AuthBroker } from "moodle-cli/worker";

const moodle = createMoodleHandler({ basePath: "/moodle" });

export default {
  async fetch(request: Request, env: MoodleWorkerEnv & YourEnv) {
    // Before your own routes: it also answers /.well-known/oauth-*/moodle...
    const response = await moodle.fetch(request, env);
    if (response) return response;
    // Your routes. Read Moodle without going through MCP:
    const due = await callMoodleTool(env.SESSION_BROKER, "due", { days: 14 });
    return due.isError ? Response.json(due.structuredContent.error, { status: 502 }) : Response.json(due.structuredContent);
  },
};
```

Add these to the host's wrangler config. `compatibility_date` must be 2024-04-03 or later for Durable Object RPC, and the host needs `@cloudflare/workers-types` for `cloudflare:workers`.

```json
{
  "durable_objects": {
    "bindings": [
      { "name": "SESSION_BROKER", "class_name": "SessionBroker" },
      { "name": "AUTH_BROKER", "class_name": "AuthBroker" }
    ]
  },
  "migrations": [{ "tag": "moodle-cli-v1", "new_sqlite_classes": ["SessionBroker", "AuthBroker"] }],
  "browser": { "binding": "BROWSER" }
}
```

Append the migration to any the host already has. Deploy the host, then put the secrets into it and sign in:

```bash
moodle mcp deploy --host-worker <name> --host-url https://<host> --base-path /moodle
```

That uploads secrets into the named Worker and never deploys code to it. `moodle mcp login`, `pair`, `status` and session renewal then target `https://<host>/moodle`; connect clients to `https://<host>/moodle/mcp`. `moodle mcp remove` forgets the local profile and leaves the host alone.

The secrets use the names in `MoodleWorkerEnv`, such as `MOODLE_ORIGIN`, `EXPECTED_HOST` and `SESSION_ENCRYPTION_KEY`. A host that already binds one of those names for itself will have it overwritten.

`callMoodleTool` returns the same envelope as the MCP tool: `{ isError: false, structuredContent }`, or `{ isError: true, structuredContent: { error: { type, message } } }` with `type` such as `MOODLE_AUTH_REQUIRED`. `unitsOutputSchema`, `dueOutputSchema` and `toolContracts` are the zod contracts behind it.

## Contributing

Bug reports from real Moodle sites help most: run `moodle coverage --json` and attach the output. Read [CONTRIBUTING.md](CONTRIBUTING.md) before a pull request and [SECURITY.md](SECURITY.md) for vulnerabilities. Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## 🦄 Part of unicorn

Live tools answer what is there now; unicorn answers what changed.

| Project | Layer | What it does |
| --- | --- | --- |
| [🦄 unicorn](https://github.com/TuuHub/unicorn) | Memory | Remembers your campus sources and tells your agent what changed. Remote MCP. |
| **[moodle-cli](https://github.com/bunizao/moodle-cli)** (you are here) | **Live** | **Moodle. CLI, local and remote MCP.** |
| [edstem-cli](https://github.com/bunizao/edstem-cli) | Live | Ed Discussion. CLI, local and remote MCP. |
| [ontrack](https://github.com/bunizao/ontrack-cli) | Live | OnTrack and Doubtfire. CLI only. |

📖 [All docs](https://unicorn.tuuhub.com/docs) · [CLIs overview](https://unicorn.tuuhub.com/cli) · [Connect an MCP client](https://unicorn.tuuhub.com/docs/mcp)

## License

[MIT](LICENSE). Use, copy, modify and redistribute it, including commercially. Keep the copyright notice and license text with any copy.
