# Forums

Read this file for forum discovery, title or body search, discussion reading, grouped forums, unread posts, or rendering checks.

## Default Search

Start with the narrowest high-level command:

```bash
moodle forums search QUERY --json
```

Refine it with:

- `--course COURSE` to restrict the course.
- `--forum FORUM_OR_URL` to restrict the forum.
- `--unread-only` for unseen content.
- `--titles-only` to avoid fetching post bodies.
- `--list --limit N` for a shortlist.
- `--body` only when the winning snippet is insufficient.
- `--limit-forums N` and `--limit-discussions N` to bound large-site scans.

Use `moodle forums search QUERY --json` and narrow with `--limit` when only a few matches are needed.

When one request combines search with the full matching post, use one command:

```bash
moodle forums search QUERY --course UNIT --limit 1 --json
```

Reserve `forum discussion` for an existing discussion ID or URL, or for selecting a known post ID.

## Browse or Open Directly

| Need | Command |
| --- | --- |
| List forum activities | `moodle forums UNIT --json` |
| List discussions in one forum | `moodle forums show FORUM_OR_URL --json` |
| Read a discussion | `moodle threads show DISCUSSION_OR_URL --json` |
| Read one post | `moodle threads show DISCUSSION_OR_URL --post POST_ID --json` |
| Include full bodies in terminal format | `moodle threads show DISCUSSION_OR_URL --body --table` |

Skip discovery when the user already supplied a discussion URL. Use `forum discussions` when they supplied a forum view URL and want nearby threads.

Grouped forums are resolved automatically. An empty default group page does not prove the forum has no discussions.

## Structured Forum Content

Prefer these fields over text heuristics:

- `image_urls` for original images
- `links` for extracted hyperlinks
- `tables` for table rows and headers
- `group_id` and `group_name` for group context
- `unread` and `time_created` for unread/recent requests

The branch is complete when the selected discussion or post matches the query and the answer retains the source URL.
