# Command Reference

Generated from the live command tree. UNIT is a code/name, id or URL from `moodle units`.
`moodle UNIT SECTION` resolves a section; `moodle UNIT "TASK"` resolves an item.
Resources and folders return `files` with names and URLs. Pass a selected file URL to
`moodle get URL --to DIR`. Validate the receipt: path, byte count and content type.
`moodle download SOURCE --dest PATH --force` retains the exact-path replacement flow.

{{generated_command_reference}}

{{generated_output_contract}}

MCP 0.8 discovers home, due, units, unit, find, item, grades, news, thread,
search_forums and file. Legacy names remain callable for one minor version and return
compact v2 envelopes. They are deprecated and omitted from default discovery.
Unit results contain a section index; supply section for activity details.
List activity URLs follow `{siteurl}/mod/{type}/view.php?id={id}`; use item for the actual URL.
File content is embedded in MCP resource blocks, limited to 16 MiB. CLI downloads stream to disk.
