# Development guide

How to build, test and release moodle-cli. For how to propose a change, see [CONTRIBUTING.md](../CONTRIBUTING.md). For a deeper map of the code, see [AGENTS.md](../AGENTS.md).

## Setup

You need Node.js 22.13 or later; older Node cannot read browser cookies. Bun works too.

```bash
git clone https://github.com/bunizao/moodle-cli.git
cd moodle-cli
npm ci
npm run build
```

Run the CLI from source, or from the build:

```bash
node --experimental-strip-types src/cli.ts user
node dist/moodle.js user
```

Both use your real configuration in `~/.config/moodle-cli/` and your real browser session. `MOODLE_BASE_URL` and `MOODLE_CONFIG` point a run at another site or config file.

## Layout

The repo ships two things that share most of their code:

- **The CLI** (`src/`) reads Moodle through the AJAX endpoint the web UI uses, signed in with the browser's `MoodleSession` cookie. It falls back to reading pages when a site disables a service.
- **The Worker** (`src/worker/`) is a Cloudflare Worker that serves the same data over MCP. The CLI bundles it and deploys it with Wrangler.

| Path | What lives there |
| --- | --- |
| `src/cli.ts` | The Commander program: every command and option. |
| `src/moodle-client-core.ts`, `src/client.ts` | The Moodle API. Core code runs in both Node and the Worker; Node-only code lives in the sibling file. |
| `src/parsers.ts`, `src/models.ts` | Moodle JSON and HTML to typed models. |
| `src/formatters.ts`, `src/terminal-table.ts` | Human output. Every command also takes `--json`. |
| `src/intent-contract.ts` | The MCP tools' inputs and outputs, shared by the local server and the Worker. |
| `src/mcp/` | The MCP protocol, deployment, credentials and session renewal. |
| `src/worker/` | The Worker: routing, OAuth, the session Durable Object, its own Moodle calls. |
| `tests/` | Vitest suites. `tests/fixtures/` holds saved Moodle responses and pages, with `moodle-5.0/` covering Boost, Classic and edge cases. |
| `scripts/` | Build checks, smoke tests and the Moodle lab, described below. |
| `SKILL.md`, `references/`, `agents/` | The generated agent skill bundle. Do not edit by hand. |
| `docs/` | Plans, research and decision records. |

A module ending in `-core.ts` is the runtime-neutral half of a feature. Put logic there when the Worker needs it too, and keep `fs`, `child_process` and keychain access in the Node sibling.

## Checks

```bash
npm run check        # type check
npm test             # every Vitest suite
npm run build        # type check, CLI and Worker bundles, bundle and vocabulary checks
npm run pack:check   # the npm tarball carries every shipped file
```

Narrower test lanes:

```bash
npm run test:mcp     # MCP server, deployment, renewal and client connectors
npm run test:worker  # Worker suites
npm run test:watch   # rerun on save
npx vitest run tests/grades.test.ts
```

`tests/intents.test.ts` holds the MCP tool catalog under a character budget, because every hosted client pays for the catalog on every request. If a description change breaks the budget, shorten the text rather than raising the limit.

## Scripts

Most scripts run in CI. You will usually only run them when you touch the part they guard.

| Command | Script | What it does |
| --- | --- | --- |
| `npm run build` | `check-worker-bundle.mjs` | Fails if the Worker bundle imports a package instead of inlining it. |
| `npm run build` | `check-shipped-vocabulary.mjs` | Fails if a shipped file names an institution or one of its unit codes. |
| `npm run pack:smoke` | `smoke-packed-output.mjs` | Packs and installs the tarball in a temp folder, then checks `--version`, help output and table and JSON rendering against a synthetic site. |
| `npm run bin:smoke` | `smoke-standalone.mjs` | Builds the Bun standalone binary and checks that it runs and carries the Worker payloads. Needs Bun. |
| (release only) | `build-standalone.mjs` | Builds a standalone binary for one target: `bun scripts/build-standalone.mjs OUT bun-linux-x64`. |
| `npm run test:worker:runtime` | `smoke-worker.mjs` | Runs the built Worker in Miniflare and drives the MCP and OAuth flows end to end. |
| `npm run test:worker:browser` | `smoke-worker-browser.mjs` | Opens the OAuth consent page in headless Chromium. Run `npx playwright install chromium` once first. |
| `npm run measure:mcp` | `measure-mcp.mjs` | Prints the size of `tools/list` and of each tool's answer on the fixture site, in characters and estimated tokens. Run it before and after changing tool output. |
| `npm run skill:generate` | (CLI) | Regenerates `SKILL.md`, `references/` and `agents/openai.yaml` from the command tree. Needs a build first. |

## The Moodle lab

Unit tests use saved pages, so they cannot show what a real site renders under another theme or language. `scripts/lab/` installs a throwaway Moodle 5.0 with known contents and runs `moodle coverage` against it under each variant:

```bash
scripts/lab/install.sh                  # about 70 seconds; rerun to start over
npm run build && scripts/lab/matrix.sh  # every theme, language and service variant
```

It needs PostgreSQL 16, PHP 8.2 to 8.4 and root, so a Linux container or VM is the easy place to run it. See [scripts/lab/README.md](../scripts/lab/README.md) for the variants and lab users. Use it whenever you change a page reader or `coverage`.

## Testing against your own Moodle

`moodle coverage` runs every read-only command once against your units and checks each answer against a second source on the site. Run it before and after a change to a reader:

```bash
node dist/moodle.js coverage
```

Commands that write to Moodle, such as `submit` and quiz attempts, have no safe test site. Exercise them only against the lab, or against an assignment you are allowed to resubmit.

## The MCP Worker

`moodle mcp deploy` deploys the bundled Worker to your own Cloudflare account. When you change Worker code, build first so the deploy picks up `dist/worker/`:

```bash
npm run build
node dist/moodle.js mcp deploy
node dist/moodle.js mcp status
```

`src/mcp/protocol.ts` is the single source of truth for protocol versions. Gate any header or metadata requirement on the modern protocol version only, because hosted clients negotiate the compatibility revisions.

## Release

Releases are cut from `main` by a maintainer.

1. Bump the version in `package.json`, `package-lock.json` and `src/version.ts`.
2. Write `.github/release-notes/<version>.md`. It becomes the GitHub release body. Put one paragraph on each line, because GitHub keeps single line breaks. Lead with one sentence on what the release is, then `## Highlights`, then a section per change.
3. Commit as `chore(release): <version>` and merge it to `main`.
4. Tag it and push the tag: `git tag -s v<version> && git push origin v<version>`.

The tag starts `.github/workflows/release.yml`. It reruns CI, checks that the tag matches `package.json`, and publishes to npm with trusted publishing. A version with a prerelease part, such as `1.0.0-beta.1`, goes to the `beta` dist-tag. It then builds the standalone binaries for macOS arm64 and Linux x64 and creates the GitHub release with the notes file.

## Conventions

- English comments that explain why, not what.
- [Conventional Commits](https://www.conventionalcommits.org/).
- Never log or print a credential.
- No institution-specific vocabulary in code, tests or docs.
- Errors from the Worker are RFC 9457 `problem+json` with a relative `type` such as `/problems/...`.
