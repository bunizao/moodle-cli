# Coursework and Grades

Read this file for grades or detail about assignments, quizzes, resources, links, pages, and folders.

## Grades

Use a course ID or unique course name:

```bash
moodle grades UNIT --json
```

Report the course total and requested grade items. Preserve displayed values and percentages; Moodle gradebooks may expose text such as ranges, letters, or incomplete totals.

## Activity Detail

Each command accepts a numeric module ID or its full Moodle URL:

| Activity | Command |
| --- | --- |
All supported activity types share the course-module ID namespace and use one command:

```bash
moodle activities show ACTIVITY_ID --json
```

The result includes `type` (`assign`, `quiz`, `resource`, `link`, `page`, or `folder`).

Resource and folder details include `file_entries` with a filename, authenticated URL, and authentication requirement. When the user wants local files, continue with [downloads.md](downloads.md) instead of fetching those URLs outside the CLI.

When the user supplies a supported Moodle URL without naming a command, route it directly:

```bash
moodle 'MOODLE_URL' --json
```

The CLI recognizes course, grade report, forum, assignment, quiz, resource, link, page, and folder URLs. For another activity URL, it may fall back to the containing course.

## Agent Steps

1. Use the activity-specific command when the activity type is known.
2. Use direct URL routing when the user already supplied a URL and only wants its content.
3. Return structured links and `file_entries` from the result instead of scraping prose from the formatted table.

The branch is complete when the answer identifies the course or module and quotes the grade or activity state returned by Moodle.
