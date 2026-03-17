from __future__ import annotations

import pytest

from moodle_cli.client import MoodleClient
from moodle_cli.models import ForumActivityRef, ForumDiscussion, ForumDiscussionRef, ForumPost, ForumPostAuthor

BASE_URL = "https://school.example.edu"


def make_client() -> MoodleClient:
    return MoodleClient(BASE_URL, "session-cookie")


def test_search_forum_content_can_filter_unread_only_and_sort_recent(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()

    forums = [
        ForumActivityRef(id=501, name="General Discussion", course_id=101, course_name="Mathematics 101", url=f"{BASE_URL}/mod/forum/view.php?id=501")
    ]
    refs = [
        ForumDiscussionRef(id=9001, subject="Exam deadline questions", url=f"{BASE_URL}/mod/forum/discuss.php?d=9001"),
        ForumDiscussionRef(id=9002, subject="Lecture recap", url=f"{BASE_URL}/mod/forum/discuss.php?d=9002"),
    ]
    discussions = {
        9001: ForumDiscussion(
            id=9001,
            subject="Exam deadline questions",
            course_id=101,
            forum_id=501,
            url=f"{BASE_URL}/mod/forum/discuss.php?d=9001",
            posts=[
                ForumPost(
                    id=9101,
                    discussion_id=9001,
                    subject="Exam deadline questions",
                    message_text="Can we have an extension for the exam deadline?",
                    author=ForumPostAuthor(id=12, fullname="Alice Example"),
                    time_created=1762000000,
                    unread=True,
                    url=f"{BASE_URL}/mod/forum/discuss.php?d=9001#p9101",
                ),
                ForumPost(
                    id=9102,
                    discussion_id=9001,
                    subject="Re: Exam deadline questions",
                    message_text="The deadline stays the same.",
                    author=ForumPostAuthor(id=13, fullname="Tutor Example"),
                    time_created=1762000300,
                    unread=False,
                    url=f"{BASE_URL}/mod/forum/discuss.php?d=9001#p9102",
                ),
            ],
        ),
        9002: ForumDiscussion(
            id=9002,
            subject="Lecture recap",
            course_id=101,
            forum_id=501,
            url=f"{BASE_URL}/mod/forum/discuss.php?d=9002",
            posts=[
                ForumPost(
                    id=9201,
                    discussion_id=9002,
                    subject="Lecture recap",
                    message_text="Deadline summary from the last lecture.",
                    author=ForumPostAuthor(id=14, fullname="Bob Example"),
                    time_created=1762000900,
                    unread=True,
                    url=f"{BASE_URL}/mod/forum/discuss.php?d=9002#p9201",
                )
            ],
        ),
    }

    monkeypatch.setattr(client, "get_forums", lambda course_id=None: forums)
    monkeypatch.setattr(client, "get_forum_discussion_refs", lambda _forum_cmid: refs)
    monkeypatch.setattr(client, "get_forum_discussion", lambda discussion_id: discussions[discussion_id])

    hits = client.search_forum_content("deadline", unread_only=True, sort_by="recent")

    assert [(hit.discussion_id, hit.post_id) for hit in hits] == [(9002, 9201), (9001, 9101)]
    assert all(hit.unread for hit in hits)
    assert hits[0].time_created >= hits[1].time_created


def test_search_forum_content_titles_only_skips_discussion_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()

    forums = [
        ForumActivityRef(id=501, name="General Discussion", course_id=101, course_name="Mathematics 101", url=f"{BASE_URL}/mod/forum/view.php?id=501")
    ]
    refs = [ForumDiscussionRef(id=9001, subject="Exam deadline questions", url=f"{BASE_URL}/mod/forum/discuss.php?d=9001")]

    monkeypatch.setattr(client, "get_forums", lambda course_id=None: forums)
    monkeypatch.setattr(client, "get_forum_discussion_refs", lambda _forum_cmid: refs)
    monkeypatch.setattr(client, "get_forum_discussion", lambda _discussion_id: pytest.fail("titles-only search should not fetch discussion posts"))

    hits = client.search_forum_content("deadline", include_post_text=False)

    assert [(hit.discussion_id, hit.post_id, hit.matched_in) for hit in hits] == [(9001, 0, "discussion_subject")]
