---
name: moodle-cli
description: Read Moodle units, deadlines, grades and files; submit coursework, manage messages and forums, and run a private MCP server.
---

# Moodle CLI

UNIT is a code/name, id or URL; SECTION is a number/name. Discover with `moodle units`; never guess ids.

| Intent | Run |
| --- | --- |
| dashboard | moodle |
| deadlines | moodle due [UNIT] --days 14 |
| unit names | moodle units |
| a unit or section | moodle UNIT [SECTION] |
| find slides or a task | moodle find "QUERY" [UNIT] |
| submission or item detail | moodle UNIT "TASK" |
| a quiz attempt | moodle attempt ID |
| grades | moodle grades [UNIT] |
| announcements | moodle news [UNIT] |
| forum post text | moodle forums search "QUERY" --unit UNIT |
| upload assignment files | moodle submit "UNIT TASK" FILE... [--final] |
| download a file | moodle dl "UNIT TASK" --to DIR |
| messages | moodle messages list |
| read a conversation | moodle messages show ID |
| calendar events | moodle calendar --days 14 |

Pipes emit JSON; `--json` forces it. Ambiguity returns `candidates`: refine or pick.
Lists report `total`; narrow or page. Confirm writes; dry-run submissions first. `--final` is irreversible.
Never expose cookies or tokens. Sign-in: `moodle doctor`; remote expiry: `moodle mcp login`.
Syntax: `moodle commands --json` or [reference](references/command-reference.md). [Setup/MCP](references/setup-and-auth.md).
