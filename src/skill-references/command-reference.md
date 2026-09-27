# Command Reference

Generated from the live command tree. UNIT is a code/name, id or URL from `moodle units`.
`moodle UNIT SECTION` resolves a section; `moodle UNIT "TASK"` resolves an item.
Resources, folders and assignments return `files` with names and URLs.
`moodle download REF --to DIR` saves one file, every file of an activity, or a whole
section (`moodle download "UNIT week 3"` or a section URL). The receipt lists `files`
with path, byte count and content type, and `skipped` with a reason: `exists` (already
saved; `--force` replaces it) or `unavailable`. `--dest PATH` names the file when there is one.
`moodle submit "UNIT TASK" FILE... --dry-run` shows the upload plan; without `--dry-run` it
asks for confirmation (`--yes` skips it) and prints the receipt Moodle shows afterwards.
`--final` also submits for grading, which Moodle does not let anyone undo.

{{generated_command_reference}}

{{generated_output_contract}}

MCP 0.8 discovers home, due, units, unit, find, item, grades, news, thread,
search_forums and file; a local server also lists submit, the only tool that writes.
Legacy names remain callable for one minor version and return
compact v2 envelopes. They are deprecated and omitted from default discovery.
Unit results contain a section index; supply section for activity details.
List activity URLs follow `{siteurl}/mod/{type}/view.php?id={id}`; use item for the actual URL.
File content is embedded in MCP resource blocks, limited to 16 MiB. CLI downloads stream to disk.
