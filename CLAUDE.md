# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent Flags

```yaml
agent_flags:
  token_economy: prioritize
  response_style: terse
  planning_style: minimal
```

Interpret these as defaults:

- Prefer the shortest sufficient response.
- Avoid long preambles and repeated summaries.
- Ask questions only when a wrong assumption is likely to be costly.
- Make the smallest maintainable change that solves the task.

## Build & Run

TypeScript ESM, Node >= 22.13. The `moodle` bin maps to `dist/moodle.js`.

```bash
npm install
npm run check        # tsc --noEmit
npm test             # vitest run
npm run build        # tsc --noEmit + tsup (CLI) + tsup.worker (Worker) + bundle check
npm run pack:check   # assert the npm tarball carries every shipped file
```

Narrower test lanes: `npm run test:mcp`, `npm run test:worker`, `npm run test:watch`.

Run the CLI from source with `node --experimental-strip-types src/cli.ts`, or `node dist/moodle.js` after a build.

`prepublishOnly` runs test + build + pack:check, so a release fails early rather than shipping a broken tarball.

## Architecture

Two deliverables live in one repo:

1. **The CLI** (`src/`) — reads Moodle by borrowing the user's browser session.
2. **The Worker** (`src/worker/`) — a Cloudflare Worker that exposes the same data over MCP, deployed by the CLI through a bundled Wrangler.

### Moodle access

The CLI uses Moodle's **internal AJAX endpoint** (`/lib/ajax/service.php`), not the Web Services token API. That endpoint accepts the `MoodleSession` browser cookie, exactly as the web UI does. `client.ts` resolves `sesskey` from an authenticated page, then calls AJAX functions and falls back to scraping (`scraper.ts`) when a site disables a service.

Request: `POST /lib/ajax/service.php?sesskey={sesskey}&info={function}` with body `[{"index":0,"methodname":"...","args":{...}}]`. Response: `[{"error":false,"data":...}]`.

### CLI layout

- **cli.ts** — Commander program. Top-level: `user`, `units` (alias `courses`), `todo`, `alerts`, `overview`, `activities`, `download` (alias `dl`), `grades`, `threads`, `forums`, `auth`, `mcp`, `commands`, `skills`. Session handling sits under `auth`; deployment under `mcp`.
- **auth.ts** — session resolution. `MOODLE_SESSION` env var, then browser cookie extraction, then an interactive browser login. Browser cookies need Node >= 22.13 (`MINIMUM_NODE_FOR_BROWSER_COOKIES`).
- **client.ts** / **moodle-client-core.ts** — the API surface; core holds transport-free logic so it runs in both Node and the Worker.
- **parsers.ts**, **models.ts** — Moodle JSON to typed models.
- **formatters.ts**, **terminal-table.ts** — human output; every command also takes `--json`.
- **config.ts**, **url-resolver.ts** — resolve and persist `base_url`; `MOODLE_BASE_URL` overrides.
- **command-contract.ts** — reflects the Commander tree into a machine-readable description, which is what `skills.ts` generates agent manifests from. Adding a command changes generated output, so regenerate rather than hand-editing.

Modules ending in `-core.ts` are the runtime-neutral half of a feature. Put logic there when the Worker needs it too; keep Node-only concerns (fs, child_process, keychain) in the sibling file.

### Worker layout (`src/worker/`)

- **entry.ts** — the Cloudflare entrypoint; **http.ts** — routing, auth, protocol-metadata validation.
- **auth.ts** — static Bearer tokens compared against digests in secrets. **oauth.ts** / **auth-broker.ts** — a single-user OAuth 2.1 authorization server so hosted clients (claude.ai) can connect; `/oauth/register` is DCR for public clients, PKCE S256 is required, and `/authorize` refuses everything unless the user has opened a pairing window with `moodle mcp pair`.
- **session-broker.ts** — a Durable Object holding the encrypted Moodle cookie; **crypto.ts** — the envelope around it.
- **problems.ts** — every error response is RFC 9457 problem+json. `type` is a relative URI (`/problems/...`); do not invent a hostname for it.
- **moodle-upstream.ts** — the Worker's own Moodle calls.

### MCP protocol

`src/mcp/protocol.ts` is the single source of truth. `MODERN_PROTOCOL_VERSION` (`2026-07-28`) carries `_meta` client metadata and the `MCP-Method` / `MCP-Name` headers; `LEGACY_PROTOCOL_VERSION` and `COMPAT_PROTOCOL_VERSIONS` do not. Hosted clients negotiate the compat revisions, so any header or metadata requirement must be gated on the modern version alone — gating it on "not legacy" silently breaks every real client.

### Deployment (`src/mcp/deployment/`)

`moodle mcp deploy` runs `ONBOARDING_STAGES`, eight steps from validating the Moodle session through uploading secrets, deploying, and installing local integrations. `ManagedMcpDeployment.apply()` is an `AsyncIterable<DeploymentEvent>`; **progress.ts** renders those events as an in-place spinner on a TTY and as plain completed lines everywhere else. Progress goes to **stderr** so `--json` keeps stdout clean.

Credentials live in the OS keychain via `src/mcp/credentials/`. Session renewal is in `src/mcp/renewal/`.

## Conventions

- English comments only; explain why, not what. Conventional Commits.
- Never log or print the Moodle session cookie, `sesskey`, or an MCP access token.
- Browser-cookie auth is the general path. Do not add site-specific or provider-specific login flows.
- No new dependencies without a concrete reason.

## Release Notes

`.github/release-notes/<version>.md` is the GitHub release body. That renderer keeps single newlines as line breaks, so a hard-wrapped paragraph shows up as short ragged lines with a column of dead space on the right. Write one paragraph per line and let the browser wrap it; blank lines separate paragraphs.

Lead with one sentence saying what the release is, then a `## Highlights` bullet list, then a section per change. Use bullets for lists of facts and prose for anything that needs a reason.

## Adding a New Command

1. Register it in `src/cli.ts` with a `--json` option.
2. Add the AJAX function name to `constants.ts` and a method to `client.ts` (or `moodle-client-core.ts` if the Worker needs it).
3. Add the model to `models.ts` and the transform to `parsers.ts`.
4. Add human output to `formatters.ts`.
5. Add a test; `tests/cli-contract.test.ts` covers the generated contract.

## Adding a New Moodle API Call

All calls go through `MoodleClient._call(function, args)`, which handles the AJAX envelope and error extraction. Add a public method that calls it.
