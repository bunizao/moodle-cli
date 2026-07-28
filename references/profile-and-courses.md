# Profile and Courses

Read this file for identity, enrolled-course discovery, course sections, or course activity lists.

## Choose the Command

| Need | Command |
| --- | --- |
| Authenticated user and site | `moodle user --json` |
| Enrolled units | `moodle units --json` |
| Sections and nested activities | `moodle units show UNIT --json` |
| Flat activity list | `moodle activities UNIT --json` |

`UNIT` accepts a numeric ID or a unique name match. When a name could match several units, run `moodle units --json`, identify the intended unit, and continue with its ID.

## Agent Steps

1. Use `user` only for account or site identity.
2. Use `units` for discovery and ID resolution.
3. Use `course` when section placement matters; use `activities` when the user wants a flat inventory.
4. Use `--fields` only for fields present in the returned objects, for example:

```bash
moodle units --json --fields id,shortname,fullname
```

The branch is complete when the requested course or activity facts are tied to an unambiguous course ID.
