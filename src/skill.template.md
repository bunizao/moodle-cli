{{generated_frontmatter}}

# Moodle CLI

Reads Moodle; only `submit` writes. UNIT is a site code/name, id or URL; SECTION is a number or name.
Never assume code patterns or ask for ids; `moodle units` shows the vocabulary.

{{generated_intent_table}}

Pipes emit compact JSON; `--json` forces it, `--pretty` indents it.
Ambiguity returns `candidates`: pick or refine, never guess.
Lists report `total`; narrow or page when more exist. Quote ISO dates.
Never expose cookies or tokens. Download or submit only when asked; dry-run submit first. `--final` cannot be undone.
Sign-in trouble: `moodle doctor`; remote expiry: `moodle mcp login`.
Exact syntax: `moodle commands --json` or [reference](references/command-reference.md).
Setup, MCP and removal: [guide](references/setup-and-auth.md).
