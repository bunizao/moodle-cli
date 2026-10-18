# v0.11 implementation validation

Validation and review follow-up: 2026-10-19, Australia/Melbourne. Runtime implementation revision: `e5e3495c038cc01e9e2380d8f6e35c99ae08af80` (reachable in the activity-state PR; later commits isolate the test fixtures); implementation starts after `47a548f58ab3ebcd1c3d54fcb2102ffbd2a2d77a` on main. Both revisions are reachable in the PR series. The original working branch and unrelated untracked PDF were preserved. Changes are published as PRs #58–#67; no release or production deployment was performed.

## Checks

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm test` | 58 suites; 875 passed, 1 platform-specific Windows credential test skipped on macOS |
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


## Returned PR review follow-up

All 16 returned findings were independently checked and fixed. The download case was reproduced with `--force`: the normal existence check already classifies a blocked parent, while forced nested directory creation previously leaked the raw filesystem error.

| PR | Confirmed issues addressed |
| --- | --- |
| #58 | General calendar event ids and records in ground truth; Composer/Git/PHP preflight before setup |
| #59 | Refill filtered dashboard pages, including limits above the 50-event API cap |
| #61 | Classify nested destination failures as configuration errors |
| #62 | Submit access passwords when resuming; use server time for absolute countdowns |
| #63 | Profile timezone in human output; specific event URLs; native-calendar month navigation |
| #64 | Text-only replacements may remove old files; mixed consent discloses both writes |
| #65 | Reuse forum HTML verification and clear stale cache; enforce attachment count before uploading |
| #66 | Fill missing list restriction text from course HTML; render state fields once |
| #67 | Record reachable PR-series revisions instead of unpublished implementation commits |

Independent follow-up reviews found **0 Standards findings** and **0 Spec findings**. The Spec reviewer ran 122 tests from nine public-interface suites in an immutable archive, and confirmed against Moodle source that `nextperiod.timestamp` is the first day of the next active-calendar month. The final full test and lab results above supersede the original implementation counts.

Additional real-lab review probes passed: a fresh session resumed the same password-protected timed attempt; text-only replacement removed the old file; messages/conversation/calendar retained `Asia/Tokyo` while the host used UTC; reply and new-discussion verification succeeded with the discussion-post AJAX reader disabled.

The Linux CI follow-up exposed a malformed calendar fixture (`userid` instead of Moodle's `userId`) previously masked by a host session cache. The CLI tests now disable caches and use a valid authenticated context. The failure was reproduced locally with caches disabled and corrected; a real Linux invocation returned the expected calendar JSON with exit code 0.
