import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MoodleAPIError } from "../src/errors.js";
import { ForumModule, filterDiscussionToPost, parseDiscussionReference, parseForumReference } from "../src/forum.js";
import {
  formatForumActivities,
  formatForumDiscussion,
  formatForumDiscussionRefs,
  formatForumSearchHits,
} from "../src/formatters.js";
import type { Course, ForumPost, ForumSearchHit, Section } from "../src/models.js";
import { parseForumDiscussionHtml, parseForumViewCmidFromDiscussionHtml } from "../src/scraper.js";

const BASE_URL = "https://school.example.edu";
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("forum read paths", () => {
  it("parses discussion URLs with #p post anchors and filters to that post", () => {
    const parsed = parseDiscussionReference(`${BASE_URL}/mod/forum/discuss.php?d=7001#p9002`);
    expect(parsed).toEqual({ discussionId: 7001, postId: 9002 });

    const discussion = {
      id: 7001,
      subject: "Exam deadline questions",
      course_id: 101,
      forum_id: 501,
      group_id: 10,
      group_name: "Tutorial A",
      url: `${BASE_URL}/mod/forum/discuss.php?d=7001`,
      posts: [
        forumPost({ id: 9001, discussion_id: 7001, message_text: "first" }),
        forumPost({ id: 9002, discussion_id: 7001, message_text: "selected" }),
      ],
    };

    expect(filterDiscussionToPost(discussion, parsed.postId).posts).toEqual([discussion.posts[1]]);
  });

  it("loads a discussion through AJAX and extracts images, links, and tables", async () => {
    const calledFunctions: string[] = [];
    const client = new ForumModule({
      baseUrl: BASE_URL,
      call: async (functionName) => {
        calledFunctions.push(functionName);
        return {
          courseid: 101,
          forumid: 501,
          posts: [
            {
              id: 9101,
              discussionid: 7001,
              subject: "Exam deadline questions",
              message:
                '<p>Please check the <a href="/mod/resource/view.php?id=55">schedule</a>.</p><img src="/pluginfile.php/1/image.png" alt="diagram"><table><tr><th>Type</th><th>Code</th></tr><tr><td>Tutorial</td><td>685B5</td></tr></table>',
              author: { id: 12, fullname: "Alice Example", urls: { profile: `${BASE_URL}/user/view.php?id=12` } },
              timecreated: 100,
              unread: true,
              urls: { view: `${BASE_URL}/mod/forum/discuss.php?d=7001#p9101`, reply: `${BASE_URL}/mod/forum/post.php?reply=9101` },
            },
          ],
        };
      },
      getPage: async () => fixture("forum-discussion.html"),
    });

    const discussion = await client.getForumDiscussion(7001);

    expect(calledFunctions).toEqual(["mod_forum_get_discussion_posts"]);
    expect(discussion.group_id).toBe(10);
    expect(discussion.group_name).toBe("Tutorial A");
    expect(discussion.posts[0].image_urls).toEqual([`${BASE_URL}/pluginfile.php/1/image.png`]);
    expect(discussion.posts[0].links).toEqual([{ text: "schedule", url: `${BASE_URL}/mod/resource/view.php?id=55` }]);
    expect(discussion.posts[0].tables).toEqual([{ headers: ["Type", "Code"], rows: [["Tutorial", "685B5"]] }]);
  });

  it("falls back to discussion page scraping and resolves forum cmid", async () => {
    const html = fixture("forum-discussion.html");
    const client = new ForumModule({
      baseUrl: BASE_URL,
      call: async () => { throw new MoodleAPIError("disabled", "servicenotavailable"); },
      getPage: async () => html,
    });

    const discussion = await client.getForumDiscussion(7001);

    expect(discussion.posts).toHaveLength(1);
    expect(discussion.posts[0].created_pretty).toBe("Monday, 1 January 2026, 10:00 AM");
    expect(await client.getForumViewCmid(7001)).toBe(501);
    expect(parseForumViewCmidFromDiscussionHtml(html)).toBe(501);
    expect(parseForumDiscussionHtml(html, BASE_URL, 7001).posts[0].reply_url).toBe(`${BASE_URL}/mod/forum/post.php?reply=9101#mformforum`);
  });

  it("collects grouped forum discussions from non-default groups", async () => {
    const calls: string[] = [];
    const client = new ForumModule({
      baseUrl: BASE_URL,
      call: async () => { throw new Error("Unexpected AJAX call"); },
      getPage: async (path, params) => {
        const url = new URL(path, BASE_URL);
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, String(value));
        }
        calls.push(`${url.pathname}?${url.searchParams.toString()}`);
        if (url.searchParams.get("group") === "10") {
          return fixture("forum-view-group-a.html");
        }
        if (url.searchParams.get("group") === "20") {
          return fixture("forum-view-group-b.html");
        }
        return fixture("forum-view-default-grouped.html");
      },
    });

    const refs = await client.getForumDiscussionRefs(501);

    expect(calls).toEqual(["/mod/forum/view.php?id=501", "/mod/forum/view.php?id=501&group=10", "/mod/forum/view.php?id=501&group=20"]);
    expect(refs.map((ref) => [ref.id, ref.subject, ref.group_id, ref.group_name])).toEqual([
      [9001, "Exam deadline questions", 10, "Tutorial A"],
      [9002, "Lecture recap", 20, "Tutorial B"],
    ]);
  });

  it("lists forum activities from course contents", async () => {
    const courses: Course[] = [
      { id: 101, shortname: "MATH101", fullname: "Mathematics 101", category: 0, visible: true, startdate: 0 },
    ];
    const sections: Section[] = [
      {
        id: 1,
        name: "Week 1",
        section: 1,
        visible: true,
        summary: "",
        activities: [
          { id: 501, name: "General Discussion", modname: "forum", url: `${BASE_URL}/mod/forum/view.php?id=501`, visible: true, description: "" },
          { id: 601, name: "Lecture Notes", modname: "resource", url: `${BASE_URL}/mod/resource/view.php?id=601`, visible: true, description: "" },
        ],
      },
    ];
    const client = new ForumModule({
      baseUrl: BASE_URL,
      call: async () => { throw new Error("Unexpected AJAX call"); },
      getPage: async () => { throw new Error("Unexpected page load"); },
      getCourses: async () => courses,
      getCourseContents: async () => sections,
    });

    expect(await client.getForums()).toEqual([
      { id: 501, name: "General Discussion", course_id: 101, course_name: "Mathematics 101", url: `${BASE_URL}/mod/forum/view.php?id=501` },
    ]);
  });

  it("formats snippets by default and full bodies with --body behavior", () => {
    const discussion = {
      id: 7001,
      subject: "Exam deadline questions",
      course_id: 101,
      forum_id: 501,
      group_id: 0,
      group_name: "",
      url: `${BASE_URL}/mod/forum/discuss.php?d=7001`,
      posts: [forumPost({ id: 9101, discussion_id: 7001, message_text: "full body with deadline details" })],
    };

    expect(formatForumDiscussion(discussion)).toContain("Preview: full body with deadline details");
    expect(formatForumDiscussion(discussion, { showBody: true })).toContain("full body with deadline details");
  });

  it("formats fallback discussion timestamps for terminal readers", () => {
    const discussion = {
      id: 7001,
      subject: "Exam deadline questions",
      course_id: 101,
      forum_id: 501,
      group_id: 0,
      group_name: "",
      url: `${BASE_URL}/mod/forum/discuss.php?d=7001`,
      posts: [forumPost({ id: 9101, discussion_id: 7001, time_created: 1_787_320_500 })],
    };

    const output = formatForumDiscussion(discussion);

    expect(output).toMatch(/When: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/u);
    expect(output).not.toContain("1787320500");
  });

  it("removes terminal control characters from discussion text", () => {
    const discussion = {
      id: 7001,
      subject: "Exam\u001b[31m deadline",
      course_id: 101,
      forum_id: 501,
      group_id: 0,
      group_name: "",
      url: `${BASE_URL}/mod/forum/discuss.php?d=7001`,
      posts: [forumPost({
        id: 9101,
        discussion_id: 7001,
        author: { id: 12, fullname: "Alice\u0000 Example", profile_url: "", profile_image_url: "" },
      })],
    };

    const output = formatForumDiscussion(discussion);

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0000");
  });

  it("includes post IDs and URLs in forum search tables", () => {
    const hit: ForumSearchHit = {
      course_id: 101,
      course_name: "Mathematics 101",
      forum_id: 501,
      forum_name: "General Discussion",
      group_id: 0,
      group_name: "",
      discussion_id: 7001,
      discussion_subject: "Exam deadline questions",
      post_id: 9101,
      author_name: "Alice Example",
      matched_in: "post",
      snippet: "deadline details",
      unread: true,
      time_created: 1_787_320_500,
      url: "https://x/1",
    };

    const output = formatForumSearchHits([hit]);

    expect(output).toMatch(/│ Po │/u);
    expect(output).toMatch(/│ st │/u);
    expect(output).toMatch(/│ 91 │/u);
    expect(output).toMatch(/│ 01 │/u);
    expect(output).toContain("Alice");
    expect(output).toContain("Example");
    expect(output).toContain("https://");
    expect(output).toContain("x/1");
  });

  it("keeps empty forum results in bordered tables", () => {
    for (const output of [
      formatForumDiscussionRefs(501, []),
      formatForumActivities([]),
      formatForumSearchHits([]),
    ]) {
      expect(output).toContain("┌");
    }
  });

  it("resolves forum IDs from view and discussion URLs", async () => {
    await expect(parseForumReference(`${BASE_URL}/mod/forum/view.php?id=501`)).resolves.toBe(501);
    await expect(parseForumReference(`${BASE_URL}/mod/forum/discuss.php?d=7001`, async () => 501)).resolves.toBe(501);
  });
});

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function forumPost(overrides: Partial<ForumPost> = {}): ForumPost {
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
