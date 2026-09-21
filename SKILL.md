---
name: moodle-cli
description: Read Moodle units, deadlines, grades, announcements and files; diagnose sign-in and manage a private MCP server.
---

# Moodle CLI

Read-only Moodle data. UNIT is a site code/name, id or URL; SECTION is a number or name.
Never assume code patterns or ask for ids. `moodle units` shows the site's vocabulary.

| Intent | Run |
| --- | --- |
| dashboard | moodle |
| deadlines | moodle due [UNIT] --days 14 |
| unit names | moodle units |
| a unit or section | moodle UNIT [SECTION] |
| find slides or a task | moodle find "QUERY" [UNIT] |
| submission or item detail | moodle UNIT "TASK" |
| a quiz attempt | moodle attempt ID |
| my grades | moodle grades [UNIT] |
| announcements | moodle news [UNIT] |
| forum post text | moodle forums search "QUERY" --unit UNIT |
| download a file | moodle get "UNIT TASK" --to DIR |

Pipes emit compact JSON; `--json` forces it, `--pretty` indents it.
Ambiguity returns `candidates`: pick or refine, never guess.
Lists report `total`; narrow or page when more exist. Quote ISO dates with offsets.
Never expose cookies or tokens. Only download when requested.
Sign-in trouble: `moodle doctor`; remote expiry: `moodle mcp login`.
Exact syntax: `moodle commands --json` or [reference](references/command-reference.md).
Setup, MCP and removal: [guide](references/setup-and-auth.md).
