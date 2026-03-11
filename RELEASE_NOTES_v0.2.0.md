# moodle-cli v0.2.0

## Summary

This release adds two high-value commands for agent-driven Moodle workflows:

- `moodle todo` for upcoming actionable timeline items
- `moodle grades COURSE_ID` for course-specific grade details

It also improves compatibility with real Moodle sites by making authenticated page discovery and grade-report lookup more resilient across different site configurations.

## Highlights

### New: `moodle todo`

`moodle todo` reads Moodle timeline action events and returns upcoming work across courses.

Useful fields include:

- course name and course ID
- activity name and module type
- due timestamp
- action name and action URL
- course progress when available

This is designed for agent use cases such as:

- "What should I work on next?"
- "What is due soon?"
- "Which action link should I open?"

### New: `moodle grades COURSE_ID`

`moodle grades COURSE_ID` fetches the authenticated learner's grade view for a course and returns:

- course total
- percentage and range when available
- per-item grades
- feedback
- status indicators such as pass

This is useful for agent workflows such as:

- "What is my current standing in this course?"
- "Which assessments are still ungraded?"
- "Show feedback for graded work."

## Compatibility improvements

### More robust authenticated page parsing

Some Moodle sites do not expose the same user-name markup on every authenticated page. Session detection now works as long as the required session metadata is present, improving compatibility with real-world Moodle themes and layouts.

### Grade report fallback strategy

Grade report lookup is no longer hardcoded to a single Moodle path.

The CLI now tries:

- course-specific grades links discovered from course navigation
- site-specific course grade pages such as `/course/user.php?mode=grade`
- grade overview pages when a course-level report is not directly available
- standard Moodle grade report paths as fallback

When a course does not expose grades to the learner, the CLI now returns a clear error instead of a Python traceback.

## User-visible changes

- Added `todo` to CLI help output
- Added `grades` to CLI help output
- Added structured JSON and YAML output for todo items
- Added structured JSON and YAML output for course grades
- Improved terminal rendering for grade reports by hiding empty columns when possible

## Examples

```bash
moodle todo
moodle todo --limit 10 --days 7 --json
moodle grades 41031
moodle grades 41031 --json
```

## Validation

Validated with:

- `uv run pytest tests/test_cli_e2e.py`
- real-site checks against public Moodle demo sites
- real-site checks against a Moodle deployment with non-standard grade-report routing

## Upgrade notes

No configuration changes are required.

If a site does not expose a course-level grade report, `moodle grades COURSE_ID` may still return a clear "grades not listed" message. This reflects site behavior, not a CLI crash.
