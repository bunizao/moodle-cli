from __future__ import annotations

import pytest

import moodle_cli.client as client_module
import moodle_cli.parser as parser_module
import moodle_cli.scraper as scraper_module
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


def test_get_forum_discussion_enriches_group_metadata_after_ajax_parse(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()

    class FakeResponse:
        text = """
        <html>
          <body>
            <form id="mformforum">
              <input name="groupid" value="1973651">
              <select name="groupinfo">
                <option value="1973651">CALLISTA</option>
              </select>
            </form>
          </body>
        </html>
        """

    monkeypatch.setattr(client, "_ensure_session", lambda: None)
    monkeypatch.setattr(
        client,
        "_call",
        lambda _function_name, _args=None: {
            "posts": [
                {
                    "id": 9001,
                    "discussionid": 7001,
                    "subject": "Week 3 Attendance Codes",
                    "message": "<p>Hello</p>",
                    "author": {"id": 1, "fullname": "Teacher"},
                    "urls": {"view": f"{BASE_URL}/mod/forum/discuss.php?d=7001#p9001"},
                }
            ]
        },
    )
    monkeypatch.setattr(client, "_get", lambda path, params=None: FakeResponse())

    discussion = client.get_forum_discussion(7001)

    assert discussion.group_id == 1973651
    assert discussion.group_name == "CALLISTA"


def test_parse_forum_group_ids_extracts_visible_group_options() -> None:
    html = """
    <html>
      <body>
        <form id="selectgroup" action="https://school.example.edu/mod/forum/view.php" method="get">
          <select name="group" id="single_select123">
            <option value="2077747">Applied</option>
            <option value="2077757">Workshop</option>
            <option value="1973651">CALLISTA</option>
          </select>
        </form>
      </body>
    </html>
    """

    assert scraper_module.parse_forum_group_ids_html(html) == [2077747, 2077757, 1973651]


def test_get_forum_discussion_refs_collects_discussions_from_all_groups(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    calls: list[dict | None] = []

    class FakeResponse:
        def __init__(self, text: str) -> None:
            self.text = text

    monkeypatch.setattr(client, "_ensure_session", lambda: None)

    group_html = {
        None: "<html><select name='group'><option value='10'>A</option><option value='20'>B</option></select></html>",
        10: "<html><a href='/mod/forum/discuss.php?d=9001'>Week 1</a></html>",
        20: "<html><a href='/mod/forum/discuss.php?d=9002'>Week 2</a></html>",
    }

    def fake_get(path: str, params: dict | None = None) -> FakeResponse:
        assert path == "/mod/forum/view.php"
        calls.append(params)
        group = None if params is None else params.get("group")
        return FakeResponse(group_html[group])

    def fake_parse_refs(html: str, base_url: str) -> list[ForumDiscussionRef]:
        if "9001" in html:
            return [ForumDiscussionRef(id=9001, subject="Week 1", url=f"{BASE_URL}/mod/forum/discuss.php?d=9001")]
        if "9002" in html:
            return [ForumDiscussionRef(id=9002, subject="Week 2", url=f"{BASE_URL}/mod/forum/discuss.php?d=9002")]
        return []

    monkeypatch.setattr(client, "_get", fake_get)
    monkeypatch.setattr(client_module, "parse_forum_discussion_refs_html", fake_parse_refs)
    monkeypatch.setattr(
        client_module,
        "parse_forum_groups_html",
        lambda html: [(10, "A"), (20, "B")] if "select" in html else [],
    )

    refs = client.get_forum_discussion_refs(501)

    assert calls == [{"id": 501}, {"id": 501, "group": 10}, {"id": 501, "group": 20}]
    assert [ref.id for ref in refs] == [9001, 9002]
    assert [(ref.group_id, ref.group_name) for ref in refs] == [(10, "A"), (20, "B")]


def test_parse_forum_post_extracts_links_tables_and_images() -> None:
    post = parser_module.parse_forum_post(
        {
            "id": 9001,
            "discussionid": 7001,
            "subject": "Week 3 Attendance Codes",
            "message": """
                <p>See <a href="/mod/resource/view.php?id=55">schedule</a>.</p>
                <table>
                  <tr><th>Type</th><th>Code</th></tr>
                  <tr><td>Tutorial</td><td>685B5</td></tr>
                </table>
                <p><img src="/pluginfile.php/1/image.png" alt=""></p>
            """,
            "author": {"id": 1, "fullname": "Teacher"},
            "urls": {"view": f"{BASE_URL}/mod/forum/discuss.php?d=7001#p9001"},
        }
    )

    assert post.links == [{"text": "schedule", "url": f"{BASE_URL}/mod/resource/view.php?id=55"}]
    assert post.tables == [{"headers": ["Type", "Code"], "rows": [["Tutorial", "685B5"]]}]
    assert post.image_urls == [f"{BASE_URL}/pluginfile.php/1/image.png"]


def test_parse_forum_discussion_html_extracts_group_and_structured_content() -> None:
    html = f"""
    <html>
      <body>
        <form id="mformforum">
          <input name="groupid" value="1973651">
          <select name="groupinfo" id="id_groupinfo">
            <option value="1973651">CALLISTA</option>
          </select>
        </form>
        <div class="forumpost" data-post-id="9001">
          <div class="header">
            <h3>Week 3 Attendance Codes</h3>
            <a href="/user/view.php?id=1">Teacher</a>
            <div class="date">Today</div>
          </div>
          <div class="content">
            <p>See <a href="/mod/resource/view.php?id=55">schedule</a>.</p>
            <table>
              <tr><th>Type</th><th>Code</th></tr>
              <tr><td>Tutorial</td><td>685B5</td></tr>
            </table>
          </div>
        </div>
      </body>
    </html>
    """

    discussion = scraper_module.parse_forum_discussion_html(html, BASE_URL, 7001)

    assert discussion.group_id == 1973651
    assert discussion.group_name == "CALLISTA"
    assert discussion.posts[0].links == [{"text": "schedule", "url": f"{BASE_URL}/mod/resource/view.php?id=55"}]
    assert discussion.posts[0].tables == [{"headers": ["Type", "Code"], "rows": [["Tutorial", "685B5"]]}]


def test_search_forum_content_respects_forum_and_discussion_scan_budgets(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    forum_calls: list[int] = []
    discussion_calls: list[int] = []

    forums = [
        ForumActivityRef(id=501, name="Forum A", course_id=101, course_name="Mathematics 101"),
        ForumActivityRef(id=502, name="Forum B", course_id=101, course_name="Mathematics 101"),
        ForumActivityRef(id=503, name="Forum C", course_id=101, course_name="Mathematics 101"),
    ]
    refs_by_forum = {
        501: [
            ForumDiscussionRef(id=9001, subject="deadline alpha", url=f"{BASE_URL}/mod/forum/discuss.php?d=9001"),
            ForumDiscussionRef(id=9002, subject="deadline beta", url=f"{BASE_URL}/mod/forum/discuss.php?d=9002"),
            ForumDiscussionRef(id=9003, subject="deadline gamma", url=f"{BASE_URL}/mod/forum/discuss.php?d=9003"),
        ],
        502: [
            ForumDiscussionRef(id=9101, subject="deadline delta", url=f"{BASE_URL}/mod/forum/discuss.php?d=9101"),
            ForumDiscussionRef(id=9102, subject="deadline epsilon", url=f"{BASE_URL}/mod/forum/discuss.php?d=9102"),
        ],
        503: [ForumDiscussionRef(id=9201, subject="deadline zeta", url=f"{BASE_URL}/mod/forum/discuss.php?d=9201")],
    }
    discussions = {
        9001: ForumDiscussion(id=9001, subject="deadline alpha", posts=[]),
        9002: ForumDiscussion(id=9002, subject="deadline beta", posts=[]),
        9101: ForumDiscussion(id=9101, subject="deadline delta", posts=[]),
        9102: ForumDiscussion(id=9102, subject="deadline epsilon", posts=[]),
    }

    monkeypatch.setattr(client, "get_forums", lambda course_id=None: forums)

    def fake_get_forum_discussion_refs(forum_cmid: int) -> list[ForumDiscussionRef]:
        forum_calls.append(forum_cmid)
        return refs_by_forum[forum_cmid]

    def fake_get_forum_discussion(discussion_id: int) -> ForumDiscussion:
        discussion_calls.append(discussion_id)
        return discussions[discussion_id]

    monkeypatch.setattr(client, "get_forum_discussion_refs", fake_get_forum_discussion_refs)
    monkeypatch.setattr(client, "get_forum_discussion", fake_get_forum_discussion)

    hits = client.search_forum_content(
        "deadline",
        include_post_text=False,
        max_forums=2,
        max_discussions_per_forum=2,
    )

    assert forum_calls == [501, 502]
    assert discussion_calls == []
    assert [hit.discussion_id for hit in hits] == [9001, 9002, 9101, 9102]


def test_search_forum_content_carries_group_metadata_into_hits(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()

    forums = [ForumActivityRef(id=501, name="Forum A", course_id=101, course_name="Mathematics 101")]
    refs = [ForumDiscussionRef(id=9001, subject="deadline alpha", group_id=10, group_name="Tutorial A", url=f"{BASE_URL}/mod/forum/discuss.php?d=9001")]

    monkeypatch.setattr(client, "get_forums", lambda course_id=None: forums)
    monkeypatch.setattr(client, "get_forum_discussion_refs", lambda _forum_cmid: refs)
    monkeypatch.setattr(client, "get_forum_discussion", lambda _discussion_id: pytest.fail("titles-only search should not fetch discussion posts"))

    hits = client.search_forum_content("deadline", include_post_text=False)

    assert [(hit.group_id, hit.group_name) for hit in hits] == [(10, "Tutorial A")]
