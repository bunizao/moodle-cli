# Moodle CLI: Interaction Design for Humans and Agents

**Status:** Proposed design

**Baseline:** `fix/mcp-readable-results` @ `aaf4661`. Dogfooded 2026-09-15 as a student
(by unit and week) and as an agent (via the live MCP server). Builds on
`mcp-token-efficiency.md` (payload size) and `cli-product-recommendation.md` (install,
runtime, table bugs). This document covers the interaction model itself: what a person
types, what they see, and how an agent reaches a target in one call.

## 0. Vocabulary rule

Everything that ships as text (help, SKILL.md, tool descriptions, error hints, examples)
is institution-neutral:

- **No institution-specific vocabulary.** No real unit codes, unit names, site hosts,
  lecturer names or semester labels in any shipped text. Examples use the placeholder
  `UNIT` (and `<part of the unit name>`); mock screens in this document use fictional
  values whose shapes deliberately differ from each other.
- **Never assume a code format.** Unit codes are whatever the site shows: `IT101`,
  `2024-S2-ALG`, `bio.240`, `Introduction to Law`, or no code at all. Matching never
  tests for "letters then digits" or any other pattern. A unit reference is compared
  against the site's own list (shortname, fullname, id, URL) and nothing else.
- **The site's unit list is the vocabulary.** `moodle units` is the canonical way to
  learn what a unit is called on this site; every error that mentions units prints that
  list so the person can copy the site's spelling.
- **Section labels are not assumed either.** Sites label sections "Week 7", "Topic 7",
  "Module 7", "Semana 7" or with free text. A section reference is a number (matched as
  a standalone number in the section name, whatever the label word) or a name substring.

## 1. First principles

A student never thinks in course-module ids, discussion ids or section indexes. They
think in six nouns and they say them in this order:

| They say | They mean |
|---|---|
| the unit's code or name, as the site shows it | a unit (never its numeric id) |
| "week 7", "topic 7", "module 7" | a section of a unit |
| "assignment 1", "the mini test", "the slides" | an activity, by fuzzy name |
| "what's due" | the timeline across units |
| "my grades" | the gradebook, usually across units |
| "announcements", "what did the lecturer say" | the news forum's latest posts |

Today the CLI is verb-noun plumbing (`units show <id>`, `activities show <id>`,
`threads show <id>`). Getting "week 7 slides for UNIT" takes four commands and a
42 KB scroll: `units list` → read an id → `units show <id>` → find an activity id →
`activities show <id>` → `download <id>`. An agent takes the same four calls and
pays ~12,000 tokens. Both are wrong for the same reason: the tool makes the user do the
resolution that the tool should do.

**Design rule:** every human path is expressible with nothing but the six nouns above.
Ids appear only as dim secondary information and in `--json`. Every agent path to a
concrete item is one call.

## 2. Command grammar

Two layers, like git's porcelain and plumbing. The existing verb-noun tree stays as
plumbing (scripts and the generated command reference keep working). A new porcelain
layer is what people and agents use.

```
moodle                              home: this week, due soon, unread
moodle due [--days N] [UNIT]        what's due (alias of todo)
moodle grades [UNIT]                all units, or one
moodle news [UNIT] [--limit N]      latest announcements, with the post text
moodle find QUERY [UNIT]            search sections, activities, forums, threads

moodle UNIT                         unit home: current section, due in this unit, last news
moodle UNIT SECTION                 one section, with its activities and files
moodle UNIT grades | news | files | forums | due
moodle UNIT QUERY                   fuzzy: "assignment 1", "mini test", "slides week 7"

moodle get REF [--to DIR]           download; REF = id, URL, or "UNIT week 7 slides"
moodle open REF                     open REF in the browser
moodle <moodle url>                 unchanged: paste any Moodle URL

moodle doctor | auth | mcp | setup  plumbing, unchanged in shape
```

The grammar is `moodle [UNIT] [WHAT] [WHICH]`: a noun phrase. `UNIT` is the unit's
code or name exactly as the site shows it (case-insensitive), or its id or URL. It is
resolved first. If the first word is not a unit and not a known command, it is treated
as a `find` query across all units. `SECTION` is a number (`7`, `week 7`, `topic 7`)
or a name substring. The resolver already exists (`resolveCourseReference`,
`src/url-resolver.ts:146`) and already handles fullname substrings; only the top-level
dispatch (`src/cli.ts:151-159`) refuses non-URL targets today.

### Resolution rules (shared by CLI and MCP)

1. **Unit:** exact shortname or fullname (case-insensitive) → unique substring of
   shortname or fullname → id → URL. No pattern matching on the reference itself. Zero
   matches: "No unit matches '<ref>'. Your units: <the site's list>." Several matches:
   list them; on a TTY offer a numbered pick, in JSON return `code: "ambiguous"` with
   `candidates`.
2. **Section:** if the reference contains a number N, the section whose name contains N
   as a standalone number (so "7" does not match "17"; the label word before it is
   irrelevant); else a section whose name contains the reference text; else, for a bare
   number, section index N with a note in the output that this was positional. If the
   reference is omitted, the section carrying Moodle's `current` marker. Never silently
   guess between two matches.
3. **Query:** token match (all tokens present) over section names, then activity names,
   then forum and thread subjects within the unit. Rank: exact name → all tokens in name
   → tokens across name and section. Labels (`label`, `cms` chrome) are searched but
   ranked last and shown only if nothing else matches.
4. **Current section:** Moodle's highlighted section (`core_courseformat_get_state`
   `section.current`) when present; otherwise the section whose name contains the week
   number computed from the unit's `startdate` (with an "estimated" tag); otherwise
   none, and the unit home shows the first section with unfinished items instead.
   Always printed with the date range so a wrong guess is visible.

### Why this and not a REPL or TUI

A REPL would add a mode. A TUI would kill piping and agents. Noun-phrase commands are
what people already type into a search bar, they compose with `--json`, and they are
what an agent produces most reliably from a user's sentence.

## 3. What the human sees

Default output on a TTY is designed per screen, not generated from a generic table. Every
screen ends with one dim "Try" line: the next thing this person is most likely to want.
Dates are relative and absolute: `in 3 days · Fri 19 Sep, 11:55 pm`. The site's user
timezone is used and printed once on the home screen. Colour is used for three things
only: overdue (red), due within 48 h (yellow), done (green). `NO_COLOR` and piping
disable it.

The mock screens below use a fictional site with four units whose codes have different
shapes on purpose: `DB240`, `algo-2`, `STATS`, and `Ethics in Computing` (a unit with
no code at all, so its name is its label).

**`moodle`** (home, replaces "print the help"):

```
Alex · moodle.example.edu · Week 8 (est.) · Europe/Berlin

Due soon
  in 3 days   DB240    Assignment 1 – Schema design (30%)   not submitted
  in 3 days   algo-2   Week 7 Mini Test                     not submitted
  in 10 days  algo-2   Week 8 Mini Test
  in 11 days  STATS    Practice quiz 3                      opens

Unread  2 messages · 0 notifications

Units   DB240 · algo-2 · STATS · Ethics in Computing

Try  moodle DB240 · moodle due --days 30 · moodle grades
```

**`moodle algo-2`** (unit home):

```
algo-2 · Algorithms and Data Structures

This week · Week 8 – Graphs (est., 14–20 Sep)
  lecture   Week 8 Lecture slides                 pdf
  lesson    Week 8 Studio
  assign    Week 8 – Mini Test                    due in 10 days

Due in this unit
  in 3 days   Week 7 – Mini Test                  not submitted
  in 10 days  Week 8 – Mini Test

Latest news · Announcements
  2 days ago  Assignment 1 results released  (Unit coordinator)

Try  moodle algo-2 7 · moodle algo-2 grades · moodle algo-2 news
```

**`moodle algo-2 7`** (also `moodle algo-2 "week 7"`; the label word is the site's):

```
algo-2 · Week 7 – Sorting (7–13 Sep)

  lecture   Week 7 Lecture slides                 pdf · 2.1 MB      #6030851
  lecture   Week 7 Lecture recording              link
  lesson    Week 7 Studio
  assign    Week 7 – Mini Test                    due in 3 days     #6030863
  quiz      Week 7 Practice quiz                  no attempts

Try  moodle get "algo-2 week 7 slides" · moodle algo-2 "mini test"
```

Ids are printed dim at the right edge because the next command may want them, but no
command *requires* them.

**`moodle algo-2 "mini test"`** (fuzzy → one activity, or a pick list):

```
Two matches in algo-2:
  1  Week 7 – Mini Test    assign   due in 3 days
  2  Week 8 – Mini Test    assign   due in 10 days
Pick [1-2], or refine: moodle algo-2 "week 7 mini test"
```

**`moodle grades`** (all units, one screen):

```
algo-2   Algorithms and Data Structures   3 of 18 graded
  Week 2 Mini Test           3.00 / 3        Well done
  Week 3 Mini Test           0.00 / 3        Late
  Assignment 1 (6.25%)       –               due in 3 days
DB240    Databases                        2 of 9 graded
  Applied Task 3 (1%)        0.50 / 1
…
Try  moodle algo-2 grades · moodle grades --json
```

Ungraded rows show the due date instead of a dash, which is what the student actually
wants to know about an ungraded item.

**Errors** on a TTY are one line, plus a hint. The unit list in the first line is the
site's own, so the person can copy the spelling:

```
✗ No unit matches 'algo-3'.  Your units: DB240, algo-2, STATS, Ethics in Computing
✗ Unknown command 'unit'.  Did you mean 'units'?
✗ Not signed in to moodle.example.edu.  Run: moodle auth login   (or: moodle doctor)
```

JSON errors keep the current envelope and exit codes; they gain `hint` on every code and
`candidates` on `ambiguous`.

## 4. What the agent sees

### 4.1 Tool set v2 (MCP), one call per intent

Every tool accepts `unit` as the site's code or name, id or URL. Every list returns
`total` when truncated. Timestamps are ISO 8601 with offset **and** epoch
(`due: "2026-09-19T23:55:00+02:00", due_at: 1789826100`), so the agent never converts.
Field names are uniform: `id`, `name`, `code`, `type`, `unit_id`, `section_id`, `due`.
No `fullname` vs `activity_name` vs `course_name` variants.

| Tool | Replaces | Input | Returns |
|---|---|---|---|
| `home` | `get_overview` | `days?` | today, timezone, current section per unit, due (compact), unread counts, units `{id, code, name}` |
| `due` | `get_overview.todo` | `days?, unit?, limit?` | due items with `unit_code`, `activity_id`, status |
| `units` | `list_courses` | — | `{id, code, name, start, end}` |
| `unit` | `get_course` | `unit, section?` | unit + section index by default; one section with activities and files when `section` given (number or name) |
| `find` | (new) `list_courses`+`get_course`+`get_activity` | `query, unit?, types?, limit?` | ranked items `{type, id, name, unit_code, section, due?, files?}` |
| `item` | `get_activity` | `ref` (id, URL, or `"UNIT assignment 1"`) | activity detail: due, submission and grading status, grade, `files[]`, for forums the latest threads |
| `grades` | `get_grades` | `unit?, graded_only?` | all units if omitted; per unit `{code, graded, total, items[]}` |
| `news` | `list_forums`+`get_thread`×N | `unit?, limit?` | latest announcement threads with first-post text, across units if omitted |
| `thread` | `get_thread` | `discussion_id, limit?, offset?` | posts, compact |
| `search_forums` | same | same | + top-level `forums`/`units` name maps |
| `file` | `get_file` | `ref` (id, URL, or `"UNIT week 7 slides"`) | file content, ≤16 MiB |

Eleven tools, same count as today, but each maps to one thing a person says.

### 4.2 Description template

Each description follows one shape, generated from `command-contract.ts` so the CLI
help, SKILL.md and `tools/list` cannot drift:

> **What** it returns. **Use when** the user says … **Not for** … (use X). **Refs**
> accepted. **Then** what to call next. **Cost** relative size.

Concrete text for the three most-used tools:

- `find` — "Search one unit or all units for sections, activities, forums and threads
  by name. Use when the user names something ("week 7 slides", "assignment 1",
  "tutorial forum") and you do not have its id. Not for due dates (use `due`) or forum
  post text (use `search_forums`). `unit` is the unit's code or name as the site shows
  it (see `units`), or its id. Then call `item` or `file` with the returned id. Cost:
  small (≤ 20 rows)."
- `unit` — "Get a unit's home: its sections as an index with activity counts, plus the
  current section. Pass `section: 7` (a number matched in section names, whatever the
  site calls sections) or `section: "<name>"` to get that section's activities and
  files instead. Use when the user asks what is in a unit or a week. Not for a single
  named item (use `find`). Cost: index ~4 KB; one section ~0.5 KB; never returns all
  activities at once, use `find` or per-section calls."
- `home` — "The student's dashboard: today's date and timezone, the current section of
  each unit, items due in the next `days` (default 14), unread counts, and the unit
  list with ids and codes. Use first when the request is vague ("what's going on",
  "anything due") and to learn how units are named on this site. Not for a full
  deadline list beyond `days` (use `due`). Cost: ~1 KB."

### 4.3 Paths, before and after

| Intent | Calls today | Tokens today | Calls after | Tokens after |
|---|---:|---:|---:|---:|
| "What's due this week?" | 1 (`get_overview`) | 1,100 | 1 (`home`) | ~300 |
| "Week 7 slides for UNIT" | 4 (`list_courses`, `get_course`, `get_activity`, `get_file`) | ~12,400 + file | 1–2 (`find` → `file`, or `file("UNIT week 7 slides")`) | ~250 + file |
| "Is assignment 1 submitted?" | 3 (`list_courses`, `get_course`, `get_activity`) | ~12,000 | 1 (`item("UNIT assignment 1")`) | ~150 |
| "What did UNIT announce?" | 3 (`list_forums`, forum listing, `get_thread`) | ~1,900 | 1 (`news("UNIT")`) | ~600 |
| "How am I doing overall?" | 1 + N (`list_courses`, `get_grades`×5) | ~5,500 | 1 (`grades`) | ~1,500 |
| "What's in week 8 of UNIT?" | 2 (`list_courses`, `get_course`) | ~8,400 | 1 (`unit("UNIT", section 8)`) | ~500 |

Token figures for "today" come from the measured payloads in `mcp-token-efficiency.md`;
"after" figures are the compact shapes from that document applied to the narrower
result. The structural win is the call count: six common intents go from 14 calls to 7,
and none needs an id the agent did not already have.

## 5. The skill, rewritten around what people say

Today SKILL.md tells the agent to classify the request, open one of nine reference
files, then run "the narrowest command". That is three hops before the first command,
and the references are hand-written prose that can drift. Replace it with an intent
table that *is* the instruction, generated from the contract. Draft of the whole
SKILL.md body (≈1.5 KB instead of 3.1 KB, and the six common intents need no reference
file at all):

```markdown
# Moodle CLI

Read-only access to the student's Moodle. Address things the way the student does:
`UNIT` is the unit's code or name exactly as the site shows it, a section is a number
or its name, an activity is a fuzzy name ("assignment 1"). Never ask the user for
numeric ids; the CLI resolves names and lists candidates when ambiguous. Do not assume
what a unit code looks like; `moodle units` shows how this site names them.

| The user says | Run | Notes |
|---|---|---|
| what's due / deadlines / this week | `moodle due --days 14` | add UNIT to narrow |
| anything going on / dashboard | `moodle` | current section, due, unread, unit names |
| what's in UNIT / week 7 | `moodle UNIT 7` | omit the section for the unit home; `"week 7"` also works |
| the slides / a file / a link | `moodle find "week 7 slides" UNIT` then `moodle get <id> --to DIR` | `get` also accepts the phrase |
| assignment status / is it submitted / mark | `moodle UNIT "assignment 1"` | shows due, status, grade, files |
| my grades / how am I doing | `moodle grades [UNIT]` | all units when omitted |
| announcements / what did the lecturer say | `moodle news [UNIT]` | includes post text |
| forum question / did anyone ask about X | `moodle forums search "X" --unit UNIT` then `moodle threads show <id>` | |
| a pasted Moodle URL | `moodle <url>` | routes by URL type |
| sign-in problems, "not working" | `moodle doctor` | prints the fix |

Rules
- Piped output is compact JSON; add `--json` to force it, `--pretty` for humans.
- Ambiguity returns `code: "ambiguous"` with `candidates`; pick or refine, never guess.
- Every list carries `total`; if `total > returned`, narrow with UNIT or `--limit`.
- Dates come as ISO with offset plus `_at` epoch; quote the ISO form to the user.
- Never print `MOODLE_SESSION` or cookie values. Only `get` writes to disk.
- For exact flags: `moodle commands --json` (source of truth) or references/command-reference.md.
```

The nine reference files shrink to three: `command-reference.md` (generated, kept),
`downloads.md` (folder iteration and receipt verification, the only genuinely
procedural content), and `setup.md` (doctor, auth, mcp). Everything else in the current
references is either restated by the table above or is prose about behaviour the CLI
should simply have.

## 6. Agent pain points from dogfooding (my own list)

These are the things that cost me tokens or led me toward wrong answers while using the
live server in this session. Each maps to a change above.

1. **I could not get to "week 7" without fetching the whole course.** 42 KB, 230 rows,
   83 of them `label` chrome, to find one section. → `unit(section)`, `find`.
2. **Two tools returned the same courses.** `get_overview.courses` and `list_courses`
   were byte-identical; I did not know which was canonical and called both. → `home`
   carries `{id, code}` only; `units` is the list.
3. **Every id had to come from a previous call.** No tool accepted the unit's code or
   name. → all tools take a unit reference; `item`/`file` take a phrase.
4. **Epoch timestamps.** I converted `1789826100` in my head to answer "when is it due",
   with no timezone given. → ISO with offset plus epoch, timezone on `home`.
5. **"This week" was undefined.** Nothing told me today's date, the site timezone or
   which week the semester is in. → `home.today`, `home.timezone`, `current_section`.
6. **Schema said defaults were required.** I passed `todoLimit: 5, alertsLimit: 5` on
   every call because `tools/list` marked them required. → `io: "input"`.
7. **Truncation was silent.** `list_activities` returned 100 of 230 with no marker; I
   would have reported "there is no week 12". → `total` on every list.
8. **Descriptions gave no cost or sibling guidance.** Nothing said `get_course` is the
   40 KB tool or that `list_activities` is a subset of it. → the description template.
9. **`get_activity` on a resource returned an empty object.** `name: ""`,
   `file_entries: []`, no error. I would have concluded there is no file. → bug fix
   (`cli-product-recommendation.md` §3.6) and `item` must never return an empty record
   without `error`.
10. **Field names changed per tool.** `fullname`/`shortname`/`course_name`/`name`/
    `activity_name` for the same concepts. I guessed field names more than once. →
    uniform `id/name/code/type/unit_id`.
11. **Empty strings everywhere.** `feedback: ""`, `percentage: ""`, `created_pretty: ""`
    made me check whether empty meant "no data" or "not fetched". → omit-empty; a
    field is present only when it has a value.
12. **Names were noise.** A course name of 105 characters repeated in every todo row;
    activity `name` = `activity_name` + " is due". → codes in rows, one name per object.
13. **Announcements took three hops.** Forum list → forum discussions → thread. The one
    thing a lecturer says is the thing a student asks about most. → `news`.
14. **Auth failure over MCP had no next step.** "Sign in again" is not something I can
    relay as an action. → `hint` with the exact command for the machine that deployed.
15. **No content search.** I could search forum posts but not activity or section names,
    so "find the tutorial sheet" was a full-course fetch and a scan. → `find`.
16. **I guessed the shape of unit codes.** Having seen one site, I started writing its
    code pattern into examples. That is wrong for every other site. → §0: shipped text
    uses `UNIT`; resolution compares against the site's list and never a pattern.

## 7. Metrics

| Metric | Now | Target |
|---|---:|---:|
| commands a student types for "week 7 slides" | 4 + a 42 KB scroll | 1 (`moodle get "UNIT week 7 slides"`) or 2 |
| human paths that require a numeric id | all detail paths | 0 |
| agent calls for the six common intents (table 4.3) | 14 | 7 |
| agent tokens for the same six intents | ~41,300 | ~3,300 |
| screens ending with a "Try" next step | 0 | all |
| tools whose description states use-when / not-for / cost | 2 of 11 (partial) | 11 of 11 |
| SKILL.md bytes an agent loads for a common intent | 3,161 + one reference (1–6 KB) | ≤ 1,500, no reference |
| hand-written reference files with no drift check | 7 | 0 (2 remain, both checked) |
| errors with a hint | `auth` only | all codes |
| ambiguity handled by listing candidates | unit names only | unit, section, activity, forum |
| institution-specific literals in shipped text (help, SKILL.md, descriptions) | present | 0 (lint test greps the built artefacts) |

Acceptance tests to pin, on a fixture site whose unit codes have deliberately different
shapes (one alphanumeric, one with a hyphen, one all letters, one with no code): a
fixture unit with sections labelled "Week 7" and, in a second fixture, "Topic 7" and
"Semana 7", each with two "Mini Test" activities; `moodle UNIT 7` returns exactly that
section in all three labelling styles; `moodle UNIT "mini test"` returns `ambiguous`
with two candidates; `find("week 7 slides", "UNIT")` ranks the resource first; a unit
reference matching by fullname substring resolves for the code-less unit; `home`
includes `today`, `timezone`, and each unit's `current_section`; no JSON result contains
`""` or `[]`; `tools/list` descriptions equal the contract render; no built artefact
contains a real institution's host or unit code.

## 8. Order of work

1. Resolution layer (`src/resolve.ts`): unit, section, query, current section. Pure
   functions over the existing models, unit-tested on the fixtures above. Everything
   else calls this.
2. Porcelain dispatch: `moodle UNIT [WHAT] [WHICH]`, `due`, `grades`, `news`, `find`,
   `get`, `open`. Plumbing untouched.
3. Screens: home, unit, section, grades, item, errors. Snapshot-tested at 80 columns.
4. MCP v2 tools on the same resolver and the same serializer; old tool names kept as
   aliases for one minor version with a deprecation note in the description.
5. Contract-generated descriptions, SKILL.md v2, drift test, reference consolidation,
   institution-literal lint.

Steps 1–3 ship as 0.8 (additive for humans, plumbing unchanged). Step 4 is the MCP
shape change already planned in `mcp-token-efficiency.md` and should ship in the same
minor so agents relearn once.
