---
name: moodle-cli
description: Use when the user wants Moodle data from this repository through the local `moodle` CLI. Route each request to the smallest command that answers it, prefer `moodle ... --json`, avoid broad commands such as `overview` when a narrower command exists, and summarize the parsed result instead of pasting raw JSON.
---

# Moodle CLI Routing

Use the narrowest command that answers the request.

Prefer `moodle ... --json` for agent work.

Resolve course IDs with `moodle courses --json` before running course-specific commands when the user gives only a course name.

Avoid `moodle overview --json` unless the user explicitly asks for a combined snapshot across courses, deadlines, and alerts.

# Intent To Command

Use these mappings.

| User intent | Command |
| --- | --- |
| Show my profile or account info | `moodle user --json` |
| List my courses | `moodle courses --json` |
| Find the nearest deadlines or upcoming todo items | `moodle todo --limit 5 --days 14 --json` |
| List more upcoming deadlines | `moodle todo --limit 20 --json` |
| Show alerts, reminders, or unread notifications | `moodle alerts --limit 10 --json` |
| Show a combined dashboard only when explicitly requested | `moodle overview --todo-limit 5 --alerts-limit 5 --json` |
| Show activities in a course | `moodle activities COURSE_ID --json` |
| Show course contents or sections in a course | `moodle course COURSE_ID --json` |
| Show grades for a course | `moodle grades COURSE_ID --json` |
| Check whether this CLI has an update | `moodle update --json` |

# Operating Rules

Parse the JSON locally and return a concise answer.

Do not paste full command output unless the user explicitly asks for raw JSON.

If the user asks for "recent", "next", or "nearest", sort by relevance and mention exact timestamps from `due_at` or `created_at`.

If a request is ambiguous between activities, courses, and grades, inspect courses first and then run the smallest follow-up command.
