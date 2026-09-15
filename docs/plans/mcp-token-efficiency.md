# Moodle MCP: Token Efficiency Plan

**Status:** Proposed

**Baseline:** `fix/mcp-readable-results` @ `b8555aa` (0.7.1 prep), measured live against
`moodle.example.edu` on 2026-09-15 with a 5-course student account.

**Token estimate:** `tokens = chars / 3.6`. Compact JSON tokenizes at roughly 3.3–3.8
chars/token on Claude; the ratio is held constant so relative savings are exact even if
absolute counts drift ±10%.

## 1. Baseline measurements

Every number below is the exact character count of the JSON that reached the model
(one `content[0].text` blob per call). Raw captures live in the session scratchpad
`measure/` directory.

| Tool | Args | Chars | Est. tokens | Notes |
|---|---|---:|---:|---|
| `tools/list` | — | 15,341 | 4,261 | paid once per session; `outputSchema` = 9,448 of it |
| `get_user` | — | 150 | 42 | |
| `get_overview` | 5/5 (defaults) | 3,954 | 1,098 | todo = 2,612, courses = 841, alerts = 297 |
| `get_overview` | 1/1 | 1,968 | 547 | courses + alerts + user = 1,279 fixed cost |
| `get_overview` | 20/20, 60 days | 11,487 | 3,191 | ~502 chars per todo item |
| `list_courses` | 100 | 853 | 237 | 5 courses |
| `get_course` | 46579 | 41,843 | 11,623 | 63 sections, 230 activities |
| `get_course` | 46381 | 29,460 | 8,183 | 66 sections, 144 activities |
| `list_activities` | 100 | 15,489 / 16,385 | 4,302 / 4,551 | silently truncates 230 → 100 |
| `get_activity` | forum/resource/quiz/assign | 181–426 | 50–118 | |
| `get_grades` | 46381 | 4,727 | 1,313 | 18 items, 15 ungraded |
| `get_grades` | 46579 | 1,291 | 359 | |
| `list_forums` | course 46579 | 547 | 152 | 2 forums |
| `list_forums` | all | 1,075 | 299 | O(courses) upstream calls |
| `search_forums` | "assignment" | 1,271 | 353 | 2 hits |
| `get_thread` | 777384 | 4,040 | 1,122 | **1 post** |
| `get_thread` | 797151 | 1,858 | 516 | **1 post** |

### Three representative sessions (before)

| Session | Calls | Chars | Est. tokens |
|---|---|---:|---:|
| S1 "What's due this week?" | catalog + get_overview | 19,295 | 5,360 |
| S2 "Find the week 7 slides in UNIT" | catalog + list_courses + get_course + get_activity | 45,880 | 12,744 |
| S3 "Summarise the AT1 announcement" | catalog + search_forums + get_thread | 20,652 | 5,737 |

## 2. Where the bytes go (findings)

**F1. Output schemas do not enforce anything.** Every `*Value` schema in
`src/mcp/server.ts` is `z.looseObject`, which passes unknown keys through. Verified:
`z.looseObject({a}).parse({a,b})` → `{a,b}`. So the published `outputSchema` names 6
fields on a forum post while 18 are emitted. Undeclared pass-through accounts for:

- `get_thread`: `message_html`, `image_urls`, `links`, `tables`, `created_pretty`,
  `reply_url`, `is_deleted`, `is_private_reply`, `parent_id`, `time_*`, author
  `profile_url`/`profile_image_url` → **~55% of the payload**.
  `message_html` alone is 1.6–2.4× `message_text` for identical content.
- `get_overview.todo[]`: `name`, `course_name`, `action_url`, `action_name`, `overdue`,
  `actionable`, `course_progress`, `activity_name`, `modname`, `event_type` → 8 of 14
  keys undeclared. `overview.alerts` is not in the schema at all.
- `get_grades`: `weight`, `contribution`, `status` (empty on 21/21 items).
- `search_forums`: `group_id`, `group_name`, `author_name`, `matched_in`, `unread`,
  `time_created`.

**F2. `get_overview.courses` is byte-identical to `list_courses`.** Same `parseCourses`
call, same 841 bytes, no way to suppress. Plus `overview.user` duplicates `get_user`.

**F3. Todo items are 46% reconstructable.** In 20/20 items: `course_name` equals
`courses[].fullname` for `course_id`; `activity_name` is a substring of `name`;
`action_url` starts with `url`; `action_name` is a function of `(modname, event_type)`
(3 distinct values in 20 rows). `alertsLimit` changes nothing: `alerts.notifications`
is always `[]` and 7 of 10 counters are `0`.

**F4. `get_course` is 70% structural noise.** Across 374 activities in two courses:

| Field | Bytes (46579) | Share | Observation |
|---|---:|---:|---|
| `name` | 11,113 | 27% | the only payload that matters |
| `url` | 8,931 | 21% | `{siteurl}/mod/{modname}/view.php?id={id}` in 100% of non-`cms` rows; `""` for `cms` |
| `modname` | 4,052 | 10% | needed |
| `description` | 3,680 | 9% | `""` on **374/374** activities |
| `visible` | 3,220 | 8% | `true` on 374/374 |
| `id` | 2,760 | 7% | needed |
| section wrapper | 4,603 | 11% | `summary` `""` on 129/129; `section` index = array position; `visible` all `true` |

83 of 230 activities are `label` (inline text chrome, e.g. `[fa-check-square-o]
Activities (copy) (copy) (copy)…`) and 26 are `cms` with no URL. 9 sections are empty.

**F5. `list_activities` is a strict subset of `get_course`** and its `limit=100` cap
silently drops 130 of 230 activities with no `truncated`/`total` marker. There is no
per-section filter, so the only way to see section 40 is the 42 KB full dump.

**F6. Repeated names instead of ids.** `course_name` (105 chars here) is repeated per
row in `list_forums`, `search_forums`, `todo`, `get_grades`. In the 2-row
`list_forums` call the repeated course name (210 B) outweighs both forum names (76 B).
`thread.subject` == `posts[].subject`; `thread.url` and `posts[].url` differ only by
`#p{id}`; `author` (218 B with two profile URLs) is re-serialized per post.

**F7. Empty strings are emitted everywhere.** `percentage`/`weight`/`contribution` on
21/21 grade items, `total_*` on both gradebooks, `feedback` on 16/21, `username`,
`errors: []`, `tables: []`, `group_name`, `created_pretty`, `reply_url`.

**F8. Catalog.** `tools/list` is 15,341 bytes; `outputSchema` is 9,448 (62%). Because
of F1 the output schemas are also wrong. Separately, zod 4's `toJSONSchema` marks every
`.optional().default(x)` input as `required` (`get_overview` requires `todoLimit` and
`alertsLimit`; `search_forums` requires `includePostText`, `unreadOnly`, `sortBy`),
which forces the model to spell out defaults on every call.

**F9. Double serialization.** `callTool()` returns `content[0].text =
JSON.stringify(structuredContent)` plus `structuredContent` (commit `b3ec42e`). This is
what the MCP spec recommends for backward compatibility and Claude Code shows only the
text, so it costs 2× wire bytes but 0× model tokens here. Clients that forward both to
the model pay 2×. Not changed by this plan; noted so the wire numbers are understood.

**F10. Not a token issue but found on the way.** `search_forums includePostText=false`
changed the result set (2 → 1), not just the fields. `get_activity` on a `resource`
returned an empty object (`name: ""`, `file_entries: []`). Both are correctness bugs.

## 3. Design principles

1. **The schema is the contract.** Switch every output schema from `z.looseObject` to
   `z.object` (strips unknown keys). Anything the model should see is declared; nothing
   leaks. This one change fixes F1 and most of F3/F6/F7 by default.
2. **Omit, don't emit empty.** A single serializer pass drops `""`, `[]`, and
   `undefined` before validation. Booleans that are almost always the default
   (`visible`) become optional and are emitted only when `false`.
3. **Ids, not names, in rows.** Lists carry `course_id`; the name lives once, in the
   sibling `courses`/`forums` map or in the parent object.
4. **Derivable URLs are documented, not shipped.** Per-item `url` is dropped from list
   tools; tool descriptions state the template
   `{siteurl}/mod/{modname}/view.php?id={id}`. Single-item tools (`get_activity`,
   `get_thread`) keep one `url` at the top level.
5. **Narrow by default, widen by argument.** Big tools return an index; a filter
   argument returns the detail. Every truncation is announced with `total`.

## 4. Changes, ranked by savings per unit of work

### C1. `get_overview` diet (fixes F2, F3)

New shape:

```json
{"overview":{
  "courses":[{"id":46381,"code":"UNIT"}],
  "todo":[{"id":2420544,"activity_id":6030863,"name":"Week 7 - Mini Test","modname":"assign",
           "course_id":46381,"event":"due","due_at":1789826100,"actionable":false}],
  "alerts":{"direct_message_count":2,"starred_message_count":1},
  "todo_total":12}}
```

- `user` removed (use `get_user`). `courses` shrinks to `{id, code}` so `todo` rows can
  reference `course_id` without repeating the 105-char full name. Full course rows stay in
  `list_courses`.
- Todo keeps `id`, `activity_id` (cmid, so `get_activity` works without parsing the URL),
  `name` (= former `activity_name`), `modname`, `course_id`, `event`, `due_at`,
  `actionable`. Drops `name`-with-suffix, `course_name`, `url`, `action_url`,
  `action_name`, `overdue` (= `due_at < now`), `course_progress`.
- `alerts` emits only non-zero counters; `notifications` array removed (always empty).
  `alertsLimit` removed from the input since it never did anything.
- `errors` emitted only when non-empty. `todo_total` added so the model knows whether to
  raise `todoLimit`.

| Variant | Before | After | Δ |
|---|---:|---:|---:|
| 5 todos | 3,954 | 1,139 | **−71%** |
| 20 todos | 11,487 | 3,689 | −68% |
| 1 todo | 1,968 | 485 | −75% |

### C2. Strict output schemas + empty-omission serializer (fixes F1, F7)

Mechanical: `looseObject` → `object` in `server.ts:32-140`; declare the fields that
should survive (`activity_name`→`name`, `submission_status`, `grade`, etc. on
`get_activity`); add `stripEmpty()` in `wrapToolOutput`. Update
`tests/mcp-server.test.ts:341-403` (it pins `content[0].text === structuredContent`,
which still holds).

Effect on tools not otherwise touched:

| Tool | Before | After | Δ |
|---|---:|---:|---:|
| `get_grades` 46381 | 4,727 | 2,227 | −53% (empties + `url`; `item_type` kept) |
| `get_grades` 46579 | 1,291 | 846 | −34% (one long feedback string dominates) |
| `search_forums` | 1,271 | 988 | −22% (snippets are the payload; see C6 maps) |
| `list_forums` (course) | 547 | 171 | −69% |

### C3. `get_thread` diet (fixes F1, F6)

Post = `{id, parent_id?, author:{id,name}, time_created, message_text, links?}`.
`subject` per post emitted only when it is not `Re: {thread.subject}`. `message_html`,
`image_urls`, `tables`, `created_pretty`, `reply_url`, `is_*` flags, per-post `url`,
author profile URLs all gone. `links` kept because HTML stripping loses hrefs. Add
`limit` (default 20) + `offset` + `posts_total` so 50-post threads don't arrive whole.

| Thread | Before | After | Δ |
|---|---:|---:|---:|
| 777384 (Panopto embed) | 4,040 | 1,528 | **−62%** |
| 797151 | 1,858 | 694 | −63% |

`links` is the remaining fat in 777384 (~430 B for 2 Panopto/image URLs); keep it, it is
the only surviving pointer to attachments. Per-post cost drops from ~1,700–3,800 B to
~500–1,300 B, so a 50-post thread goes from an unbounded ~100 KB to a 20-post page of
~15–20 KB.

### C4. `get_course` becomes an index; `list_activities` gets a section filter (fixes F4, F5)

- `get_course(courseId)` returns course + sections as
  `{id, name, activity_count, hidden?}`. No activities. 63 sections ≈ 2,600 B.
- `list_activities(courseId, sectionId?, includeLabels=false, limit=200)` returns
  `{activities:[{id, name, modname, section_id, hidden?}], total}`. `description`
  emitted only when non-empty (it never was in 374 samples). `url` dropped (template in
  the description). `label` excluded by default because it is 36% of rows and carries UI
  chrome; `cms` rows keep going through since they have real titles.
- Both tools state in their description: "call `get_course` for the section index, then
  `list_activities` with `sectionId`".

| Call | Before | After | Δ |
|---|---:|---:|---:|
| `get_course` 46579 | 41,843 | 3,854 | **−91%** |
| `get_course` 46381 | 29,460 | 4,046 | −86% |
| one section (avg; max 1,250) | n/a (42 KB dump) | 300–370 | |
| whole course via `list_activities` (230 → 147 rows) | 41,843 | 14,750 | −65% |

Section names are long here ("Week 1 - Representing Arguments & Mindset"), which is why
the index is ~60 B/section rather than 40. Trade-off: a "give me everything" question
costs two calls instead of one. At 3.9 KB + 14.8 KB that is still 2.2× cheaper than
today's single call, and the common case (one section) is ~100× cheaper.

### C5. Catalog (fixes F8)

- Emit `inputSchema` via `z.toJSONSchema(input, { io: "input" })`. Verified: this makes
  every defaulted field optional (`get_overview.required` → `[]`,
  `search_forums.required` → `["query"]`). Zero payload change, but the model stops
  echoing defaults on every call and strict clients stop rejecting omitted args.
- Keep `outputSchema` but make it truthful (C2). Once truthful and strict, it shrinks
  because the model-facing fields are fewer: est. 9,448 → ~5,500.
- Tighten descriptions to include the URL template and the index→detail hand-off.

| | Before | After | Δ |
|---|---:|---:|---:|
| `tools/list` | 15,341 | ~11,000 | −28% |

Dropping `outputSchema` entirely would reach 5,717 B (−63%) but loses typed results
for clients that use them. Recommended only if a client audit shows nobody reads it.

### C6. Small fixes bundled with the above

- `list_courses`: drop `category` (always `0` here; Moodle returns the id without a
  name so it is useless to the model). `visible` only when `false`. 853 → 713.
- `get_grades`: add `gradedOnly` (default `false`); with it, 46381 goes 2,227 → 465.
- `search_forums`: emit `forums: {id: name}` and `courses: {id: code}` maps once at the
  top level instead of names per row. Fix the `includePostText=false` semantics bug
  separately (it must not change which discussions match).
- `list_activities`/`search_forums`/`get_thread`: always return `total` when truncated.

## 5. Targets

### Per-tool

| Tool | Before (chars) | Target | Δ |
|---|---:|---:|---:|
| `tools/list` | 15,341 | ~11,000 (est.) | −28% |
| `get_overview` (5) | 3,954 | 1,139 | −71% |
| `get_overview` (20) | 11,487 | 3,689 | −68% |
| `list_courses` | 853 | 713 | −16% |
| `get_course` | 41,843 | 3,854 | −91% |
| `list_activities` (one section) | 15,489 (truncated) | ~330 | −98% |
| `list_activities` (whole course) | 15,489 (truncated, 100/230) | 14,750 (complete, 147 rows) | −5% for 1.5× the rows |
| `get_grades` (18 items) | 4,727 | 2,227 (465 with `gradedOnly`) | −53% |
| `get_thread` (1 post) | 4,040 | 1,528 | −62% |
| `search_forums` | 1,271 | 988 | −22% |
| `list_forums` (course) | 547 | 171 | −69% |

All "after" values except the catalog were computed by re-shaping the captured
responses with the exact rules above; the catalog figure is an estimate.

### Per-session

| Session | Before | After | Δ | Tokens before → after |
|---|---:|---:|---:|---|
| S1 what's due | 19,295 | 12,139 | −37% | 5,360 → 3,372 |
| S2 find week 7 slides | 45,880 | 16,217 | **−65%** | 12,744 → 4,505 |
| S3 summarise announcement | 20,652 | 13,516 | −35% | 5,737 → 3,754 |

Excluding the catalog (paid once, amortised across a multi-turn session), the per-call
savings are S1 −71%, S2 −83%, S3 −53%.

### Acceptance criteria (measurable, to be pinned in tests)

1. `JSON.stringify(result).length` for the fixture courses in `tests/mcp-server.test.ts`
   stays under: `get_overview` 1,300 (5 todos), `get_course` 70 B/section + 200 fixed,
   `list_activities` 110 B/activity, `get_thread` 1,300 B/post + 250 fixed,
   `get_grades` 130 B/item + 200 fixed.
2. No `""` or `[]` value appears in any tool result (assert by walking the object).
3. No result contains a string that equals another string in the same result and is
   longer than 40 chars (catches repeated `course_name`/`subject` regressions).
4. `tools/list` ≤ 11,500 B and no `inputSchema.required` entry has a `default`.
5. `outputSchema` validates every result with `additionalProperties: false`.
6. A `scripts/measure-mcp.mjs` that replays the saved fixtures through
   `createMoodleMcpServer` and prints the per-tool table above, so the numbers are
   re-checked on every release, not once.

## 6. Order of work

1. C2 (strict schemas + empty omission) — one file, most of the wins, unlocks the rest.
2. C1 (`get_overview`) — the user-visible complaint.
3. C5 (`io: "input"` + descriptions) — five lines.
4. C4 (`get_course` index / `list_activities` section filter) — the only API shape change
   clients will notice; ship behind the 0.8 minor since it changes the hand-off pattern.
5. C3 (`get_thread`) and C6.

C1–C3 and C5 are output-only and backward compatible for any client that reads by key.
C4 is the one breaking change and should carry a tool-description note plus a
`CHANGELOG` entry.
