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
| Terminal | Explicit fixed/flexible table widths replace tty-table; narrow screens use key/value rows. IDs and grades do not split. Screens have next-step hints, human errors use two lines, piped JSON is compact and `--pretty` is explicit. |
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
| home | 1,775 |
| due, one unit | 201 |
| units | 423 |
| unit index | 410 |
| find, one resource | 279 |
| item | 248 |
| grades, four units | 1,145 |
| news | 262 |
| thread, one post | 324 |
| search_forums | 346 |
| file receipt | 133 |
| tools/list catalog | 19,277 |

Real authenticated read-only checks on 2026-09-15, with five enrolled units:

| Check | Result |
| --- | --- |
| home | 1,844 characters, no source errors |
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

The original **11,500-byte catalog target is not met**: the expanded v2 typed catalog
is 19,277 characters. The original target estimated the older tool shapes; the new
catalog includes current-section dates, all-unit grades, news and phrase resolution.
Output schemas remain present and enforce the emitted fields. Do not report the
catalog as a token reduction. The four-unit home fixture is also above the old 1,300-byte
overview budget because it includes current-section metadata and ISO dates. Data-call
savings, catalog cost and complete-session cost must be reported separately.

Section date ranges are estimates when derived from the unit start date and numeric
section label. A site-provided current marker takes priority; absent site timezone
information uses UTC with `timezone_source: fallback`. `find` searches thread subjects
only when section/activity names do not produce results, avoiding a forum crawl for
ordinary file queries. Forum-search totals describe the declared scan budget, not all
historical site discussions. Unavailable calendar enrichment does not discard an
otherwise readable activity detail.

Default discovery omits old aliases to avoid doubling the catalog; aliases are still
callable and documented in the generated command reference. Shell completion lists
commands; it does not fetch enrollment names on every tab press. Doctor's remote
readiness follow-up is `moodle mcp status`; its own MCP check inspects local receipts.

## Verification

Node and Bun regression suites (414 passing checks plus one intentional skip), 80-column screen snapshots, real Commander/HTTP
porcelain fixtures, a named local download, schema/empty omission checks, first-use
Wrangler resolution, 73-event calendar pagination, skill drift and shipped-vocabulary
checks are covered. Standalone smoke verifies both embedded Worker assets can actually
be materialized, in addition to version, a successful undeployed-profile status response and completion.

The Miniflare/workerd smoke covers MCP text/structured parity, OAuth authorization and
refresh, account-switch rejection, cross-origin cookie isolation, credential rotation,
pairing races and redaction. Browser OAuth smoke exercises the real consent page.
