import { describe, expect, it, vi } from "vitest";
import type { ForumDiscussion, ForumDiscussionRef, ForumPost } from "../src/models.js";
import {
  checkForumDiscussions,
  findForumContent,
  matchScore,
  searchForumContent,
  snippetForText,
  type ForumSearchSource,
} from "../src/forum-search.js";

const BASE_URL = "https://school.example.edu";

describe("forum search paths", () => {
  it("filters unread matches and sorts recent results like Python", async () => {
    const source = sourceFrom({
      discussions: {
        9001: discussion(9001, "Exam deadline questions", [
          post({ id: 9101, discussion_id: 9001, message_text: "The deadline is Friday.", unread: true, time_created: 100 }),
          post({ id: 9102, discussion_id: 9001, message_text: "Thanks", unread: false, time_created: 120 }),
        ]),
        9002: discussion(9002, "Lecture recap", [
          post({ id: 9201, discussion_id: 9002, message_text: "Another deadline update.", unread: true, time_created: 200 }),
        ]),
      },
    });

    const hits = await searchForumContent(source, "deadline", { unreadOnly: true, sortBy: "recent" });

    expect(hits.map((hit) => [hit.discussion_id, hit.post_id])).toEqual([
      [9002, 9201],
      [9001, 9101],
    ]);
  });

  it("titles-only search skips discussion fetches and honors scan budgets", async () => {
    const discussionCalls: number[] = [];
    const source: ForumSearchSource = {
      getForums: vi.fn(async () => [
        forum(501, "Forum A"),
        forum(502, "Forum B"),
        forum(503, "Forum C"),
      ]),
      getForumDiscussionRefs: vi.fn(async (forumCmid: number) => {
        const refs: Record<number, ForumDiscussionRef[]> = {
          501: [ref(9001, "deadline alpha"), ref(9002, "deadline beta"), ref(9003, "deadline gamma")],
          502: [ref(9101, "deadline delta"), ref(9102, "deadline epsilon")],
          503: [ref(9201, "deadline zeta")],
        };
        return refs[forumCmid] ?? [];
      }),
      getForumDiscussion: vi.fn(async (discussionId: number) => {
        discussionCalls.push(discussionId);
        return discussion(discussionId, "");
      }),
    };

    const hits = await searchForumContent(source, "deadline", {
      titlesOnly: true,
      maxForums: 2,
      maxDiscussionsPerForum: 2,
    });

    expect(source.getForumDiscussionRefs).toHaveBeenCalledTimes(2);
    expect(source.getForumDiscussionRefs).toHaveBeenNthCalledWith(1, 501);
    expect(source.getForumDiscussionRefs).toHaveBeenNthCalledWith(2, 502);
    expect(discussionCalls).toEqual([]);
    expect(hits.map((hit) => hit.discussion_id)).toEqual([9001, 9002, 9101, 9102]);
  });

  it("carries group metadata into title hits", async () => {
    const source = sourceFrom({
      refs: [ref(9001, "deadline alpha", { group_id: 10, group_name: "Tutorial A" })],
    });

    const hits = await searchForumContent(source, "deadline", { titlesOnly: true });

    expect(hits.map((hit) => [hit.group_id, hit.group_name])).toEqual([[10, "Tutorial A"]]);
  });

  it("find returns the best match, shortlist, or resolved body", async () => {
    const source = sourceFrom({
      discussions: {
        9001: discussion(9001, "Exam deadline questions", [
          post({ id: 9101, discussion_id: 9001, message_text: "deadline older", time_created: 100 }),
        ]),
        9002: discussion(9002, "Lecture recap", [
          post({ id: 9201, discussion_id: 9002, message_text: "deadline newer", time_created: 200 }),
        ]),
      },
    });

    const best = await findForumContent(source, "deadline");
    expect(best && !Array.isArray(best) && "discussion_id" in best ? best.discussion_id : 0).toBe(9002);

    const list = await findForumContent(source, "deadline", { listMode: true, limit: 2 });
    expect(Array.isArray(list) ? list.map((hit) => hit.discussion_id) : []).toEqual([9002, 9001]);

    const body = await findForumContent(source, "deadline", { showBody: true });
    expect(body && !Array.isArray(body) && "posts" in body ? body.posts.map((item) => item.id) : []).toEqual([9201]);
  });

  it("checks discussions without failing the whole scan", async () => {
    const source = sourceFrom({
      refs: [ref(9001, "ok discussion"), ref(9002, "broken discussion")],
      discussions: {
        9001: discussion(9001, "ok discussion", [post({ id: 9101, discussion_id: 9001, image_urls: [`${BASE_URL}/image.png`] })]),
      },
    });
    source.getForumDiscussion = vi.fn(async (discussionId: number) => {
      if (discussionId === 9002) {
        throw new Error("boom");
      }
      return discussion(9001, "ok discussion", [post({ id: 9101, discussion_id: 9001, image_urls: [`${BASE_URL}/image.png`] })]);
    });

    await expect(checkForumDiscussions(source, 501)).resolves.toEqual([
      { discussion_id: 9001, subject: "ok discussion", ok: true, posts: 1, images: 1 },
      { discussion_id: 9002, subject: "broken discussion", ok: false, error: "boom" },
    ]);
  });

  it("uses Python-compatible scoring and snippets", () => {
    expect(matchScore("Exam deadline questions", "deadline")).toBe(108);
    expect(matchScore("Exam final deadline", "deadline exam")).toBe(62);
    expect(snippetForText("alpha beta gamma deadline epsilon zeta", "deadline", 20)).toBe("…eta gamma deadline e…");
  });
});

function sourceFrom(options: { refs?: ForumDiscussionRef[]; discussions?: Record<number, ForumDiscussion> } = {}): ForumSearchSource {
  const refs = options.refs ?? [ref(9001, "Exam deadline questions"), ref(9002, "Lecture recap")];
  const discussions =
    options.discussions ??
    Object.fromEntries(refs.map((item) => [item.id, discussion(item.id, item.subject, [post({ id: item.id + 100, discussion_id: item.id })])]));
  return {
    getForums: vi.fn(async () => [forum(501, "General Discussion")]),
    getForumDiscussionRefs: vi.fn(async () => refs),
    getForumDiscussion: vi.fn(async (discussionId: number) => discussions[discussionId] ?? discussion(discussionId, "")),
  };
}

function forum(id: number, name: string) {
  return { id, name, course_id: 101, course_name: "Mathematics 101", url: `${BASE_URL}/mod/forum/view.php?id=${id}` };
}

function ref(id: number, subject: string, overrides: Partial<ForumDiscussionRef> = {}): ForumDiscussionRef {
  return { id, subject, group_id: 0, group_name: "", url: `${BASE_URL}/mod/forum/discuss.php?d=${id}`, ...overrides };
}

function discussion(id: number, subject: string, posts = [post({ discussion_id: id })]): ForumDiscussion {
  return {
    id,
    subject,
    course_id: 101,
    forum_id: 501,
    group_id: 0,
    group_name: "",
    url: `${BASE_URL}/mod/forum/discuss.php?d=${id}`,
    posts,
  };
}

function post(overrides: Partial<ForumPost> = {}): ForumPost {
  return {
    id: 1,
    discussion_id: 1,
    subject: "",
    message_html: "",
    message_text: "",
    image_urls: [],
    links: [],
    tables: [],
    author: { id: 0, fullname: "", profile_url: "", profile_image_url: "" },
    parent_id: 0,
    time_created: 0,
    time_modified: 0,
    created_pretty: "",
    unread: false,
    is_deleted: false,
    is_private_reply: false,
    url: "",
    reply_url: "",
    ...overrides,
  };
}
