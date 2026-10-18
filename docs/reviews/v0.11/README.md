# v0.11 implementation validation

Validated on 2026-10-18 in Australia/Melbourne. Code revision: `314d6e85607763692808fcfb380ab62447262db6`. Implementation starts after `5243855`; the existing branch and unrelated untracked PDF were preserved. No release, push or production deployment was performed.

## Checks

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm test` | 57 suites; 852 passed, 1 platform-specific Windows credential test skipped on macOS |
| `npm run build` | CLI and Worker bundles, bundle checks and shipped vocabulary passed |
| `npm run pack:check` | Passed |
| `npm run pack:smoke` | Installed tarball table/JSON output passed; production dependencies: 0 audit vulnerabilities |
| `npm run skill:generate` | Generated files match the committed sources; skill remains below 1,500 bytes |
| `npm run test:worker:runtime` | Miniflare/workerd MCP and OAuth smoke passed; no credentials leaked by the response probes |
| `scripts/lab/matrix.sh` | Six variants passed; see [matrix output](matrix.txt) |
| `node scripts/lab/acceptance.mjs` | 16 passing checks, 0 failures, 1 explicitly recorded limitation; see [report](acceptance-report.json) |

The disposable lab ran Moodle **5.0.10+ (Build: 20261002)**, PostgreSQL 16 and PHP 8.3, with real Formulas and Adaptive Multipart plugins. Its generated data covers the individual/group submission, text, message, forum, calendar/BBB, grade, restriction, completion and nested-download paths exercised by acceptance. These are local lab results, not production Moodle validation or CI results. Regenerate the lab before rerunning writes; final submissions persist.

## Standards

The independent review found AJAX names outside `constants.ts`, duplicated JSON coercion helpers, and a completion read gap on sites where the module metadata API succeeds. Shared constants/helpers now cover the first two; a public HTTP regression reproduced the missing completion state and passed after the fix. The generated guidance was also corrected to reflect the new write commands and kept within its existing size budget.

Follow-up review: no remaining actionable standards findings. No new production dependencies were added. Comments are English and commits use Conventional Commits.

## Spec

The independent review found missing canonical dates for Chinese/Japanese month suffixes and missing human announcement attachment rows. Both were reproduced by failing public-interface regressions, fixed and reviewed again. The follow-up exercised 192 Chinese/Japanese month/day combinations and the focused tests passed.

Follow-up review: no remaining actionable findings in the implemented five-day scope. The original roadmap explicitly carries the remaining Milestone 2 readers/actions, low-priority backlog and P2 into 0.12.

## Remaining limits

A stock student session cannot prove whether an assignment's first save preserves a draft. The CLI therefore refuses an initial draft-only save when the setting is unknown; initial `--final`, existing-draft saves, group waiting state and online-text finalisation were verified. This requirement remains open in the [roadmap](../../plans/v0.11-roadmap.md).

Cut-off dates remain absent from deadline rows when Moodle does not expose them to the student; assignment details report settings only when available. Locked-work limits are likewise omitted when unavailable. Countdown-only quiz pages yield an estimated `ends_at` from the server clock, with up to two seconds of rounding.

Final review counts: Standards 0 unresolved; Spec 0 unresolved actionable findings in the implemented scope. The first draft-only capability remains an explicit specification limitation, not a passing capability check.
