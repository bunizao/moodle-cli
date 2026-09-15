# Moodle CLI 0.8 implementation and evidence

Baseline: `fix/mcp-readable-results` at `2a5a59f`, in the existing release worktree.
Implemented against the interaction design, token-efficiency plan and linked product
recommendation. This is a branch implementation, not an npm release or production Worker deployment.

## Implemented behavior

| Plan area | Implementation and evidence |
| --- | --- |
| Site vocabulary | One runtime-neutral resolver for code/name/id/URL, exact matches before substrings, candidate errors, no institution-code pattern. Fixtures include four different code shapes, a code-less unit, and Week/Topic/Semana 7 versus 17. |
| Human commands | Home on a bare invocation; UNIT SECTION/TASK; due, all-unit grades, news, find, get and open. Existing command tree and URL entrypoints remain. JSON output now uses compact envelopes. |
| Resolution safety | Ambiguity returns candidates with exit 2, or a numbered pick for unit/item matches on interactive human output. Sections never guess between matches. Positional sections are marked. Dates inferred from section numbers are tagged as estimates. |
| Shared results | CLI and MCP call the same intent service. Zod object schemas strip undeclared fields; empty strings/lists are omitted. Uniform names, type/unit_id/section_id, ISO dates with offsets and epochs. |
| Narrow results | Unit defaults to a section index; section arguments return activities/files. Lists report totals, thread posts accept offset/limit. `find` searches names and falls back to discussion subjects; inline labels rank last. |
| MCP | Eleven default intent tools. Old names remain callable for the 0.8 transition, but are deprecated and omitted from discovery. Input defaults are optional in JSON Schema. Error recovery includes local/remote login commands. |
| Resource correctness | Resource views that redirect directly to file content return usable metadata; iframe/object embeds and missing page titles are supported. A live resource returned its name and one authenticated file. |
| Forum correctness | `includePostText=false` affects the snippet field only. Explicit `titlesOnly` remains a separate scope control. Node and Worker share one search implementation. News identifies Moodle's actual news forum type, not an English-name heuristic. |
| Calendar correctness | Real Moodle enforces a 50-event page cap. All-result calls now page at 50 with an event cursor, deduplicate ids, and filter units before applying the requested output limit. Regression fixture spans 73 events. |
| Terminal | Explicit fixed/flexible table widths replace tty-table; narrow screens use key/value rows. IDs and grades do not split. Screens take the terminal's own width, wrap with a hanging indent, print weekday-and-time rather than ISO strings, and count unread items in words. Human errors use two lines, piped JSON is compact and `--pretty` is explicit. |
| Runtime | One pin resolver: standalone, Bun on PATH, supported current Node. Doctor checks SQLite, browser access/stores, cache liveness, job pins and local deployment receipts. Auth status carries cookie-source provenance. |
| Packaging | Wrangler is a development dependency and resolves on demand: PATH, private pinned cache, then confirmed download. No Wrangler is needed by CLI reads, bridge or local MCP. Binary builds embed both Worker bundles. |
| Installation/removal | Standalone installer, documented footprints for six install paths, completion for three shells, previewable uninstall with explicit remote/purge options and protection against orphaning deployment receipts. |
| Guidance | Contract-derived MCP descriptions and skill intent table. SKILL.md is 1,312 bytes. Two references remain. Drift checks validate documented commands/flags and scan built CLI/Worker/guidance for institution literals. |

The compact JSON shape changes are intentionally grouped under 0.8. Consumers must
select envelope fields such as `units,total` rather than legacy row fields. Remote
Moodle reads remain read-only; no live submissions, messages, grades or files were changed.

## Measurements

Fixed, fictional fixtures are replayed by `npm run measure:mcp`. These are emitted
text payload characters, not transport bytes (MCP also carries structuredContent).

| Intent | Characters |
| --- | ---: |
| home | 1,235 |
| due, one unit | 201 |
| units | 423 |
| unit index | 275 |
| find, one resource | 279 |
| item | 248 |
| grades, four units | 1,145 |
| news | 262 |
| thread, one post | 324 |
| search_forums | 346 |
| file receipt | 133 |
| tools/list catalog | 7,203 |

Real authenticated read-only checks on 2026-09-15, with five enrolled units:

| Check | Result |
| --- | --- |
| home | 1,858 characters, no source errors |
| due over 30 days | 15 items, 3,469 characters |
| large unit index | 63 sections, 3,921 characters; baseline full result was 41,843 |
| one unit's grades | 794 characters |
| latest two announcements | 1,420 characters; total 9 |
| resource detail | Nonempty name and one stable authenticated Moodle file entry |
| MCP file content | 2,368,806 bytes and one embedded resource block; CDN redirects preserve the Moodle entry URL |

A fresh production-only tarball installation contains **11.3 MiB / 1,636 files**,
with neither Wrangler nor tty-table in production dependencies. Tarball output and
audit smoke passed. Timings and course contents can change; no real account contents
are committed as fixtures.

## Budget differences and scope limits

The catalog meets the 11,500-byte target at 7,203 characters, down from 19,277 when
it published an output schema per tool. Results are still parsed against the contract
before they are sent, so the schemas are enforced; they are simply not billed to every
session that lists the tools. `TOOL_OUTPUT_SCHEMAS` exports them for tests and clients
that want them. Data-call savings, catalog cost and complete-session cost are still
reported separately.

A section is current only when the site marks it. Counting weeks from the unit start
date named the wrong section on real sites, where that date is the enrolment open
date months before teaching starts, so the derived dates and the week guess are gone;
an unfinished section is offered instead and flagged. Absent a site timezone the host
clock is used and reported as `timezone_source: local`; a Worker has no host clock and
reports `fallback`. `find` searches thread subjects
only when section/activity names do not produce results, avoiding a forum crawl for
ordinary file queries. Forum-search totals describe the declared scan budget, not all
historical site discussions. Unavailable calendar enrichment does not discard an
otherwise readable activity detail.

Default discovery omits old aliases to avoid doubling the catalog; aliases are still
callable and documented in the generated command reference. Shell completion lists
commands; it does not fetch enrollment names on every tab press. Doctor's remote
readiness follow-up is `moodle mcp status`; its own MCP check inspects local receipts.

## Verification

Node and Bun regression suites (415 passing checks plus one intentional skip), 80-column screen snapshots, real Commander/HTTP
porcelain fixtures, a named local download, schema/empty omission checks, first-use
Wrangler resolution, 73-event calendar pagination, skill drift and shipped-vocabulary
checks are covered. Standalone smoke verifies both embedded Worker assets can actually
be materialized, in addition to version, a successful undeployed-profile status response and completion.

The Miniflare/workerd smoke covers MCP text/structured parity, OAuth authorization and
refresh, account-switch rejection, cross-origin cookie isolation, credential rotation,
pairing races and redaction. Browser OAuth smoke exercises the real consent page.

## Review fixes

A dogfooding pass over the built CLI and the stdio server found seven defects, all fixed here:

| Defect | Fix |
| --- | --- |
| `--limit` and `--days` were silently ignored on every command | Commander gives a flag declared on both the program and a subcommand to the program, so the value is read from there first; covered by a porcelain test. |
| The unit list was fetched up to eleven times per command, three requests each on sites without the enrolment service | The client memoizes it for 60 seconds; `news` dropped from about 70 requests to 39. |
| `moodle news` took 19.3 s | Only the newest `limit` discussions per forum are read, forum listings and posts run a few at a time, and `total` still counts every discussion. 5.3 s on the same account. |
| An unmatched target printed an empty search and exited 0 | It now exits 4 with the site's own unit list and skips the forum crawl. |
| Screens printed `2026-09-19T13:55:00+00:00` and yesterday's date | The host timezone is the fallback and screens print `Sat 19 Sep, 23:55`. |
| Human `--help` showed the agent contract (`Use when:`, `Not for:`, `Cost:`) | Commander gets the plain sentence; the full template stays in the tool catalog. |
| `moodle mcp serve` refused to run without `--stdio` | stdio is the only transport, so it is the default. |

The first remote CI run found that undeployed-profile status still required Linux
Secret Service. Status now checks for a deployment receipt first and returns
`NOT_DEPLOYED` without touching credentials or Wrangler when none exists. A regression
test injects an unavailable credential backend and verifies neither dependency runs.
