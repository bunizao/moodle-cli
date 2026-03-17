---
name: moodle-cli
description: Use when the user wants Moodle data from this repository through the local `moodle` CLI. Route each request to the smallest command that answers it, prefer `moodle ... --json`, avoid broad commands such as `overview` when a narrower command exists, and summarize the parsed result instead of pasting raw JSON.
---

# Moodle CLI Routing

Use the narrowest command that answers the request.

Prefer `moodle ... --json` for agent work.

Resolve course IDs with `moodle courses --json` before running course-specific commands when the user gives only a course name.

Avoid `moodle overview --json` unless the user explicitly asks for a combined snapshot across courses, deadlines, and alerts.

For forum requests, prefer `moodle forum find` over manually chaining `forum forums`, `forum discussions`, and `forum discussion`.

If the user already gives a forum discussion URL, skip search and open it directly with `moodle forum discussion URL --json`.

If the user gives a forum view URL or discussion URL and wants to browse nearby discussions, use `moodle forum discussions URL --json`.

Use scan budgets first when the site may be large:

- `--course` to narrow to one course
- `--limit-forums` to cap how many forums to scan
- `--limit-discussions` to cap how many discussions to scan per forum

Grouped forums are handled automatically. Do not assume an empty default forum page means the forum has no discussions.

Default forum agent flow:

1. Start with `moodle forum find QUERY --json`
2. Add `--unread-only` when the user wants new or unseen content
3. Add `--list --limit N` when one result is not enough and you need a shortlist
4. Add `--body` only when the snippet is insufficient and you need the full target post/discussion

Avoid `moodle forum search` unless you explicitly need a larger result set than `forum find --list`.

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
| Find the best forum match for a keyword | `moodle forum find QUERY --json` |
| Find a shortlist of forum matches | `moodle forum find QUERY --list --limit 5 --json` |
| Open the resolved forum post/discussion body | `moodle forum find QUERY --body --json` |
| Open a known forum discussion URL or ID directly | `moodle forum discussion DISCUSSION_OR_URL --json` |
| Browse discussions in a known forum URL or ID | `moodle forum discussions FORUM_OR_URL --json` |
| Check whether this CLI has an update | `moodle update --json` |

# Operating Rules

Parse the JSON locally and return a concise answer.

Do not paste full command output unless the user explicitly asks for raw JSON.

If the user asks for "recent", "next", or "nearest", sort by relevance and mention exact timestamps from `due_at` or `created_at`.

If a request is ambiguous between activities, courses, and grades, inspect courses first and then run the smallest follow-up command.

For forum work, do not enumerate forums or discussions first unless the user explicitly asks to browse. Search first, then expand only if needed.

For forum discussion output, prefer structured fields over heuristic text parsing when available:

- `image_urls` for original image links
- `links` for extracted hyperlinks
- `tables` for structured table content
- `group_id` and `group_name` for grouped forum context
