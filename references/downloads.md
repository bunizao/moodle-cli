# Local File Downloads

Read this file when the user wants one or more Moodle files saved locally. The canonical command is `moodle download`; `moodle dl` is an optional alias.

## One Resource

When the caller has an activity but not a direct file URL, inspect it first:

```bash
moodle activities show ACTIVITY_ID --json
```

For one resource, pass its positive course-module ID, same-site resource URL, or same-site `pluginfile.php` URL:

```bash
moodle download ACTIVITY_ID --dest './Course/Week 03/slides.pdf' --json
moodle download 'MOODLE_RESOURCE_URL' --dest './Course/Week 03/slides.pdf' --json
```

`--dest` is the exact downloaded file path. Without it, the CLI writes the upstream filename in the current directory. Existing files are preserved by default.

## Folder Files

The CLI does not recursively download a Moodle folder. Inspect the folder, select the relevant `file_entries`, plan each destination, and invoke `moodle download` separately for every chosen URL:

```bash
moodle activities show FOLDER_ACTIVITY_ID --json
moodle download 'FILE_ENTRY_URL' --dest './Course/Week 03/chapter-1.pdf' --json
```

Treat every `file_entries.url` as authenticated Moodle data. Use it only through the CLI and never expose Moodle cookies, sesskeys, or other credentials.

## Replacement and Verification

- Preserve an existing destination unless the user explicitly authorized replacement or you independently verified that replacing that exact path is safe.
- Add `--force` only for that verified replacement. It atomically replaces the completed destination; downloads do not use `--yes`.
- Keep `-o/--output` separate from `--dest`: output selects where the receipt is written, while destination selects the downloaded file.
- Validate the receipt fields, confirm `file_path` exists, and verify the saved file is non-empty and not a Moodle login page or unresolved resource wrapper. Command success alone is not proof of valid file content.
