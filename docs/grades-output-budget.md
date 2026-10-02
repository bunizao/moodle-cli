# Grade response measurements

The CLI defaults to marked items (`graded`); MCP defaults to per-unit counts and Moodle course totals (`summary`). Feedback is opt-in. Module filters accept `assignment` as `assign` and ignore case and surrounding whitespace.

Run `node scripts/measure-grades.mjs` to compare the current MCP tool against the pre-change implementation at `8db3553f6cd954ee9f472078291a6c344e8428dd`. Add `--live` with `MOODLE_BASE_URL` configured to read one real gradebook snapshot covering every enrolled unit through the existing browser-session authentication path. The script keeps that snapshot in memory and prints aggregate sizes only.

Sizes count the compact JSON in MCP `content[0].text`, which also matches `structuredContent`. They exclude duplicated transport fields, request sizes and model reasoning. Approximate tokens use `ceil(characters / 3.6)` as in `scripts/measure-mcp.mjs`; they are estimates, not tokenizer measurements. Detailed modes use the default 20-row page size and sum every page, so truncating a response cannot create artificial savings. Results replay the same snapshot through both versions.

## 45-item fixture

One unit has 43 ungraded H5P items, a zero-mark assignment and a marked quiz. Each marked item has 7,800 characters of marker feedback. This is the same fixture used by the regression tests.

| Response | Calls | Characters | Approx. tokens | Reduction vs old default |
| --- | ---: | ---: | ---: | ---: |
| Old default, all rows and feedback | 1 | 20,063 | 5,574 | — |
| Summary | 1 | 171 | 48 | 99.1% |
| Summary, feedback requested | 1 | 171 | 48 | 99.1% |
| Graded, without feedback | 1 | 540 | 150 | 97.3% |
| Graded, with feedback | 1 | 16,168 | 4,492 | 19.4% |
| All, without feedback, every page | 3 | 8,139 | 2,261 | 59.4% |
| All, with feedback, every page | 3 | 23,767 | 6,602 | −18.5% |
| Summary then graded, without feedback | 2 | 711 | 198 | 96.5% |
| Summary then graded, with feedback | 2 | 16,339 | 4,539 | 18.6% |

The common “what are my marks” flow still saves 96.5% of response characters when the agent makes a summary call first, but it costs an extra round trip. An agent that already knows it needs marks can request `mode: "graded"` directly. Summary omits item rows even when feedback is requested.

Fetching all rows with all feedback has no total-size saving here: new activity IDs and URLs, pagination metadata and repeated per-unit summaries make the complete paged response 18.5% larger than the old single response. Pagination bounds each call; it does not guarantee fewer total tokens. The savings come from choosing the needed rows and omitting feedback when it is not needed.

## Real gradebook, all enrolled units

Not measured yet. On 2026-10-02, `https://learning.monash.edu` had an expired local cached session and no usable browser session was available to the measurement script. No fixture result is presented as real-site evidence. After signing in with `moodle auth login`, run:

```bash
MOODLE_BASE_URL=https://learning.monash.edu node scripts/measure-grades.mjs --live
```

The live report includes the enrolled-unit count, all six summary/graded/all and feedback combinations, and both summary-then-graded flows with every page counted. No gradebook content, Moodle cookie, sesskey or access token is printed or written by the measurement script.
