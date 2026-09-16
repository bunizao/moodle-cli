# Moodle CLI: Install, Runtime, CLI and Agent Experience

**Status:** Recommendation

**Baseline:** `fix/mcp-readable-results` @ `55f21ef` (0.7.1 prep), audited 2026-09-15 on
macOS (nvm default Node 22.12.0, Bun 1.4.2) with a live Moodle session. Companion to
`mcp-token-efficiency.md`, which covers MCP payload size.

This document takes positions. Each section states the finding, the decision, and the
number that proves it landed.

## 0. The two premises, checked

**"Users who only want the CLI should not get MCP baggage."** Correct, and today they
get a lot of it. `wrangler` is a hard `dependency`, so every install path (npm, bun, npx,
bunx) pulls the Cloudflare toolchain:

| | With wrangler | Without |
|---|---:|---:|
| `node_modules` size | 273 MB | 34 MB |
| files | 7,520 | 5,803 |
| `npm install` wall clock | 5.95 s | 3.20 s |
| cold `npx moodle-cli --version` | 14.9 s | ~4 s (est.) |

The tarball also ships `dist/worker/*.js` (2.6 MB) to everyone. Meanwhile the standalone
binaries advertised as equivalent cannot run `mcp deploy` at all: `require.resolve("wrangler")`
fails inside the compiled binary and the user sees "The packaged Wrangler binary is
unavailable. Reinstall moodle-cli." `bin:smoke` only checks `--version`, so this ships.

**"On a Mac the MCP cannot run on Node, so we must push Bun."** Not as stated. Verified
live on this machine:

- The default client wiring (`moodle mcp bridge`, what `mcp connect` writes for Claude
  Desktop, Claude Code, VS Code, Cursor and Codex) is a stdio↔HTTPS proxy with a bearer
  token. It never touches cookies. It ran byte-identically on Node 22.12 and Bun.
- What breaks on Node is **browser-cookie extraction** (Chromium and Firefox SQLite
  stores) below Node 22.13, because `node:sqlite` is unflagged only from 22.13. Bun has
  `bun:sqlite` built in. Safari's binarycookies path needs no SQLite on either.
- The bigger macOS blocker is TCC: in a sandboxed terminal or under launchd, cookie
  reads fail with `EPERM` on **both** runtimes. Bun does not help there; Full Disk Access
  does.
- This machine currently has three background entries pinned to three interpreters
  (`keepalive` → nvm 22.23.2, `mcp-renewal` → bun, `~/.claude.json` → bun). That drift
  is the real runtime problem, not Node vs Bun.

So: Bun is the right *default for anything we pin* (LaunchAgents, client configs),
because it has SQLite, starts 1.8× faster (86 ms vs 152 ms), and is immune to nvm's
default changing. It is not something to demand at install time.

## 1. Install: one package, zero MCP cost until `mcp deploy`

**Decision.** Keep a single npm package; do not split CLI and MCP. The MCP server *is*
CLI code (`mcp bridge`, `mcp serve`), so a split creates version skew for nothing. Instead
make the only heavy MCP dependency lazy.

1. Remove `wrangler` from `dependencies`. `mcp deploy/status/remove/rotate/rollback`
   resolve it at call time, in this order: a `wrangler` already on PATH; a cached copy
   under `~/.config/moodle-cli/tools/wrangler@<pinned>/`; else run
   `bunx wrangler@<pinned>` or `npx --yes wrangler@<pinned>` (whichever runtime is
   present), after one confirm line: "Deploying needs Cloudflare's wrangler (about
   25 MB, cached for next time). Continue? [Y/n]". The version is pinned in
   `constants.ts`, so behaviour is as deterministic as today.
2. The standalone binary gets `mcp deploy` back through the same path (it can spawn
   `bunx`/`npx`), and `bin:smoke` grows a `mcp status` check that must not print the
   "packaged Wrangler" error.
3. Lead the README with the binary for students: an `install.sh` that drops
   `~/.local/bin/moodle` (Bun-compiled, so SQLite is built in, no Node, no nvm). npm stays
   the path for people who already have Node.
4. Add `moodle uninstall`: removes LaunchAgents (keepalive and renewal), optionally
   `mcp remove`, optionally the config dir, then prints the one package-manager command
   left to run. Today nothing documents uninstall, and `npm rm -g` strands two plists and
   a Worker.

**Targets.**

| Metric | Now | Target |
|---|---:|---:|
| CLI-only `node_modules` | 273 MB | ≤ 40 MB |
| cold `npx moodle-cli --version` | 14.9 s | ≤ 5 s |
| standalone binary `mcp status` | error | works |
| artifacts left after `moodle uninstall` + `npm rm -g` | 2 plists + Worker + config | 0 |
| install paths documented with "what it leaves on disk" | 0 of 6 | 6 of 6 |

## 2. Runtime: detect, pin once, explain once

**Decision.** Runtime-agnostic code with one resolver and one diagnostic command.

1. `moodle doctor`. One screen, also `--json`: runtime and version, whether it can read
   cookies (`node:sqlite`/`bun:sqlite` probe), each browser store found and whether it is
   readable (surfacing TCC `EPERM` with the exact System Settings path), config and
   base URL, session cache age and liveness, every LaunchAgent we own and the interpreter
   it pins, MCP profile status. This replaces the user needing to know what Bun is.
2. One `runtimeCommand()` for every pinned path. `keepalive.ts` has its own copy today;
   fold it into `mcp/self-command.ts`. Preference order when pinning: the running
   standalone binary; else `bun` on PATH; else the current `process.execPath` only if it
   passes the SQLite probe; else refuse with the hint. `doctor` warns when a pinned
   interpreter no longer exists or fails the probe.
3. Say it early, not deep. The excellent cookie-failure message today only fires after a
   cold data command. Add a one-line runtime note at first interactive run (the config
   prompt) and in `auth status`: "Runtime: node 22.12.0, cannot read browser cookies
   (needs 22.13+ or Bun). Run `moodle doctor`."
4. `keepalive install` already refuses on a bad runtime; make it also do a real test read
   so TCC failures are caught before the plist is written, not on the first tick.

**Targets.**

| Metric | Now | Target |
|---|---:|---:|
| distinct interpreters pinned on one machine | 3 | 1 |
| failure modes from the audit that `doctor` names with a fix | 0 (no command) | all 6 (sqlite, TCC, no browser, stale cache, dead pin, no config) |
| commands that say "run `moodle doctor`" on runtime errors | 0 | every auth/cookie error |

## 3. CLI interaction: fix what a student sees first

Ranked by how often it is hit. Evidence is from real runs under a pseudo-TTY.

**3.1 Tables are unreadable.** At 80 columns `units list` renders the ID `46579` as five
stacked single digits; `grades list` gets one-character Grade/Range columns and a blank
Percent column; `overview` wraps `quiz` to `q/u/i/z`. Root cause: `terminal-table.ts`
hands `tty-table` a total width and no per-column widths, so auto-fit shrinks whichever
column has the shortest header. Grades and IDs are the two things the CLI exists for.

*Decision:* drop `tty-table`. Use cli-kit's padder with explicit column specs: fixed
columns (`id`, `type`, `grade`, `due`) never wrap; one flex column (`name`) takes the
remainder and truncates with `…`. Below 60 columns fall back to a key: value list.
*Target:* snapshot tests at 60/80/100/120 columns; every ID and every grade on one line.

**3.2 Errors are JSON blobs on a TTY.** `moodle unit` prints a 7-line JSON object to
stderr. `units show 999999999` leaks Moodle's own "Can't find data record in database
table course." with no hint.

*Decision:* JSON errors only when `--json` or stdout is not a TTY. On a TTY: one line,
red, plus a hint. Every error code gets a hint, not just `auth`: `not_found` → "Run
`moodle units list` to see your unit IDs."; `usage` unknown command → "Did you mean
`units`?" (commander has suggestions; turn them on).
*Target:* 100% of error codes carry a `hint`; TTY errors ≤ 2 lines.

**3.3 Honest flags.** `-q/--quiet` has zero references in `src/`. `--no-color`/`NO_COLOR`
are no-ops because nothing emits colour. `--verbose` only affects `mcp status`. `-v` is
not an alias. `units|courses|projects`: `projects` is scaffold residue.

*Decision:* delete `--quiet` and `projects`; make `--verbose`/`-v` real (log every
upstream call with timing to stderr); introduce colour for status and errors and let
`NO_COLOR` mean something.

**3.4 Silence on slow calls.** No spinner or progress anywhere. Cold calls sit for 1–5 s.

*Decision:* stderr spinner when TTY and the call exceeds 300 ms; never on `--json`.

**3.5 Missing basics.** No shell completion (`moodle completion` is swallowed as the
`[target]` URL positional and behaves differently with `--help`). `auth status` does not
say which browser/profile the session came from. `forums list` spends most of its width
on a derivable URL column.

*Decision:* `moodle completion zsh|bash|fish`; `auth status` reports `cookie_source`;
drop URL columns from tables (URLs stay in `--json`).

**3.6 `activities show` returns an empty object for `resource`** (`name: ""`,
`file_entries: []`, no error). That is the exact type a student downloads. Bug, fix it
before any of the above.

**3.7 `mcp` onboarding explains nothing.** No `--help` under `mcp` mentions Cloudflare,
cost, or what leaves the laptop; `mcp status` dumps `ownershipTag`/`releaseDigest`.

*Decision:* `mcp deploy` opens with a fixed four-line explainer and a confirm: what is
created (a private Worker on your free Cloudflare account), what is uploaded (your Moodle
session cookie, encrypted), what runs in the background (renewal), and cost ($0 on the
free tier). `mcp status` gets a plain summary line above the raw fields.

## 4. Agent experience: one contract, two transports

**4.1 Shapes disagree, even inside the CLI.** `units show --json` returns a bare array
of sections with no course metadata; MCP `get_course` returns
`{course:{course:{…},sections:[…]}}`. Within the CLI, `units list`/`todo`/`forums list`
are bare arrays while `grades`/`overview`/`user` are wrapped objects. An agent that learns
one surface guesses wrong on the other.

*Decision:* one serializer, shared by CLI `--json` and MCP. Always a wrapped object with
the MCP key (`{courses:[…]}`), same field names, same omit-empty rules, and the compact
shapes from `mcp-token-efficiency.md` (C1–C4). `units show` returns what `get_course`
returns.
*Target:* a parity test that runs every resource through both paths and asserts deep
equality.

**4.2 Whitespace tax.** CLI JSON is always 2-space pretty-printed: 21% overhead on
`units list`, 32% on `units show`.

*Decision:* pretty on a TTY, compact when piped or `--json`; `--pretty` to force.
*Target:* 0% indentation bytes in agent-consumed output.

**4.3 Two sets of guidance for the same data.** The CLI skill has a branch map ("use
`todo` for due/deadline, `alerts` for notifications, reserve `threads show` for a known
id"). MCP tool descriptions are one line each with no sibling guidance, no cost hints, no
enumeration of supported activity types. Only `get_overview` and `list_courses` hint at
id hand-offs.

*Decision:* generate both from `command-contract.ts`: each resource carries `when`,
`instead_of`, `ids_in`, `ids_out`, `cost` fields; SKILL.md's intent table and MCP
`description` strings are rendered from them. Add a drift test that every command and
flag named in `references/*.md` exists in `commands --json` (7 of 9 reference files are
hand-written prose with no check today).
*Target:* zero drift between `--help`, SKILL.md and `tools/list`.

**4.4 `--help` cannot teach the download flow.** `file_entries`, "download accepts an
activity id", and folder iteration live only in `references/downloads.md`.

*Decision:* put the chain in the help text itself: `activities show` says "resources and
folders include `file_entries`; pass an entry or the activity id to `download`".

**4.5 Auth expiry over MCP is a dead end.** CLI says "Run `moodle auth login`." MCP says
"Sign in again." with no command.

*Decision:* MCP auth errors carry `hint: "On the machine that ran mcp deploy: moodle mcp
login"` and `doctorHint` so the agent can relay a concrete step.

**4.6 Bounded output everywhere.** No `--limit` on `units show`, `grades list`,
`activities list`; `list_activities` silently drops 130 of 230 rows.

*Decision:* every list accepts `--limit`/`--section` and reports `total` when truncated
(same rule as the MCP plan).

## 5. What a fresh student experiences after this

1. `curl -fsSL …/install.sh | sh` (or `npm i -g moodle-cli`, 34 MB). Under a minute.
2. `moodle` → asked for the Moodle URL once → session detected from the browser (or
   `moodle doctor` tells them exactly why not and which setting to flip).
3. `moodle todo` and `moodle grades list <unit>` render on one screen at 80 columns.
4. Optional: `moodle mcp deploy` explains itself in four lines, fetches wrangler on
   demand, and pins the background job to a runtime that will still work next month.
5. Any agent, CLI or MCP, sees the same shapes, the same hints, and the same ids.

## 6. Order of work

| # | Item | Size | Why first |
|---|---|---|---|
| 1 | 3.1 tables | S | the first screen every student sees is broken |
| 2 | 3.6 `activities show` resource bug | S | silent data loss |
| 3 | 1.1–1.2 lazy wrangler + binary smoke | M | 88% smaller install; fixes the broken binary |
| 4 | 4.1–4.2 shared serializer, compact when piped | M | ties CLI and MCP together; unlocks the token plan |
| 5 | 2.1–2.2 `doctor` + single `runtimeCommand()` | M | ends interpreter drift; makes Bun a detected default, not a demand |
| 6 | 3.2 TTY errors with hints, suggestions | S | |
| 7 | 4.3 contract-generated descriptions + drift test | M | |
| 8 | 3.7 mcp explainer, 1.4 `uninstall`, 3.5 completion, 3.3 flag cleanup | S each | |

Items 1, 2, 6 and 8 are non-breaking. Item 4 changes CLI JSON shapes and is the one that
needs a minor version and a changelog note; ship it together with the MCP shape changes
so agents relearn once.
