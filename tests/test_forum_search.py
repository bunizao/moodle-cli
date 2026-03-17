from __future__ import annotations

import pytest

import moodle_cli.client as client_module
from moodle_cli.exceptions import MoodleAPIError
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


def test_get_forum_discussion_refs_reuses_cached_page_result(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    calls = {"get": 0, "parse": 0}
    refs = [ForumDiscussionRef(id=9001, subject="Exam deadline questions", url=f"{BASE_URL}/mod/forum/discuss.php?d=9001")]

    class FakeResponse:
        text = "<html></html>"

    monkeypatch.setattr(client, "_ensure_session", lambda: None)

    def fake_get(path: str, params: dict | None = None) -> FakeResponse:
        assert path == "/mod/forum/view.php"
        assert params == {"id": 501}
        calls["get"] += 1
        return FakeResponse()

    def fake_parse(html: str, base_url: str) -> list[ForumDiscussionRef]:
        assert html == "<html></html>"
        assert base_url == BASE_URL
        calls["parse"] += 1
        return refs

    monkeypatch.setattr(client, "_get", fake_get)
    monkeypatch.setattr(client_module, "parse_forum_discussion_refs_html", fake_parse)

    assert client.get_forum_discussion_refs(501) == refs
    assert client.get_forum_discussion_refs(501) == refs
    assert calls == {"get": 1, "parse": 1}


def test_get_forum_discussion_reuses_cached_discussion(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    calls = {"get": 0, "parse": 0}
    discussion = ForumDiscussion(id=9001, subject="Exam deadline questions")

    class FakeResponse:
        text = "<html></html>"

    monkeypatch.setattr(client, "_ensure_session", lambda: None)
    monkeypatch.setattr(
        client,
        "_call",
        lambda _function_name, _args=None: (_ for _ in ()).throw(MoodleAPIError("disabled", error_code="servicenotavailable")),
    )

    def fake_get(path: str, params: dict | None = None) -> FakeResponse:
        assert path == "/mod/forum/discuss.php"
        assert params == {"d": 9001}
        calls["get"] += 1
        return FakeResponse()

    def fake_parse(html: str, base_url: str, discussion_id: int) -> ForumDiscussion:
        assert html == "<html></html>"
        assert base_url == BASE_URL
        assert discussion_id == 9001
        calls["parse"] += 1
        return discussion

    monkeypatch.setattr(client, "_get", fake_get)
    monkeypatch.setattr(client_module, "parse_forum_discussion_html", fake_parse)

    assert client.get_forum_discussion(9001) == discussion
    assert client.get_forum_discussion(9001) == discussion
    assert calls == {"get": 1, "parse": 1}
