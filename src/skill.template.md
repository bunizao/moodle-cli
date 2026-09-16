{{generated_frontmatter}}

# Moodle CLI

Read-only Moodle data. UNIT is a site code/name, id or URL; SECTION is a number or name.
Never assume code patterns or ask for ids. `moodle units` shows the site's vocabulary.

{{generated_intent_table}}

Pipes emit compact JSON; `--json` forces it, `--pretty` indents it.
Ambiguity returns `candidates`: pick or refine, never guess.
Lists report `total`; narrow or page when more exist. Quote ISO dates with offsets.
Never expose cookies or tokens. Only download when requested.
Sign-in trouble: `moodle doctor`; remote expiry: `moodle mcp login`.
Exact syntax: `moodle commands --json` or [reference](references/command-reference.md).
Setup, MCP and removal: [guide](references/setup-and-auth.md).
