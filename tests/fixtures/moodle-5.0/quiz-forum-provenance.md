# Quiz and forum fixture provenance

Captured on 2026-10-18 from the repository's local Moodle 5.0.10+ lab as its seeded student. The lab origin is replaced with `https://school.example.edu` and session keys with `fixture`. No real account data is present.

- `../quiz-attempt-formulas.html`: the untouched first page of attempt 5, quiz module 75, before answering. Retained the original title, heading, navigation, response form, timer element and timer initialiser. This replaces the hand-edited two-field formulas fixture. The real question has five fields, including a separate unit field.
- `formulas-attempt-saved.html`: the same page after the client saved `40 m/s`, `40`, `m/s`, `40`, `40`. Extracted the same elements.
- `forum-reply.html`: `/mod/forum/post.php?reply=10`; retained the rendered posting form and its file manager initialisation.
- `forum-new.html`: `/mod/forum/post.php?forum=12`; retained the rendered posting form and its file manager initialisation.
- `forum-before.html`: forum module 66 before discussion 12 was created; retained the discussion table, inline new-discussion form and forum subscription link.
- `forum-unsubscribed.html` and `forum-subscribed.html`: module 66 after creating discussion 12, with forum-wide subscription off and on respectively; retained the main region.
- `forum-post-result.html`: the original response after creating discussion 12. Moodle displays a success notice and a delayed redirect to the forum view, rather than an HTTP redirect to the new discussion.
- `forum-posts.json`: the unmodified `data` payload of `mod_forum_get_discussion_posts` for discussion 7 after reply 13 with `roadmap-proof.txt` was created. Attachment exporters use `url`, while older file payloads use `fileurl`.

Only unrelated page navigation/scripts were discarded. Question inputs, labels, form values, returned JSON and timer seconds were not fabricated or rewritten.
