import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MoodleClient } from "../src/client.js";
import { createMoodleGateway } from "../src/mcp/gateway.js";
import { createIntentService } from "../src/intents.js";
import { renderScreen } from "../src/screens.js";

const BASE = "https://school.example.edu";
const html = readFileSync(new URL("./fixtures/forum-discussion.html", import.meta.url), "utf8");

function clientWithPosts(posts: unknown[]) {
  const client = new MoodleClient(BASE, {
    cookie: { name: "MoodleSession", value: "test-cookie" }, sesskey: "test-key", userid: 2,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/lib/ajax/service.php") return Response.json([{ error: false, data: { courseid: 101, forumid: 10, posts } }]);
      if (url.pathname === "/my/") return new Response(readFileSync(new URL("./fixtures/dashboard.html", import.meta.url), "utf8"));
      if (url.pathname === "/mod/forum/discuss.php") return new Response(html);
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  });
  return client;
}

const posts = [
  { id: 9101, discussionid: 7001, parentid: 0, subject: "A topic", message: "<p>First post</p>", timecreated: 100, author: { id: 3, fullname: "Student" }, attachments: [{ filename: "reading.pdf", filesize: 144, fileurl: `${BASE}/pluginfile.php/9/mod_forum/attachment/9101/reading.pdf` }] },
  { id: 9102, discussionid: 7001, parentid: 9101, subject: "Re: A topic", message: "<p>A reply</p>", timecreated: 200, author: { id: 4, fullname: "Peer" } },
];

describe("forum public read surface", () => {
  it("keeps attachments and the forum module id through the CLI/MCP result schema", async () => {
    const service = createIntentService(createMoodleGateway(clientWithPosts(posts)));
    const result = await service.run("thread", { discussion_id: 7001 });
    expect(result.thread).toMatchObject({ forum_id: 501, posts: [
      { id: 9101, attachments: [{ name: "reading.pdf", size: 144, url: `${BASE}/pluginfile.php/9/mod_forum/attachment/9101/reading.pdf` }] },
      { id: 9102, parent_id: 9101 },
    ] });
    const screen = renderScreen(result);
    expect(screen).toContain("reading.pdf (144 bytes)");
    expect(screen).toContain("Posts 2 of 2");
    expect(screen).not.toContain("--offset 2");
  });

  it("suggests the next offset only while posts remain", async () => {
    const service = createIntentService(createMoodleGateway(clientWithPosts(posts)));
    const result = await service.run("thread", { discussion_id: 7001, limit: 1 });
    expect(renderScreen(result)).toContain("--offset 1");
  });
});


const fixture = (name: string) => readFileSync(new URL(`./fixtures/moodle-5.0/${name}`, import.meta.url), "utf8");
function responseAt(html: string, url: string): Response {
  const response = new Response(html, { headers: { "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
function writeClient(fetchImpl: typeof fetch) {
  return new MoodleClient(BASE, { cookie: { name: "MoodleSession", value: "test-cookie" }, sesskey: "fixture", userid: 3, fetchImpl });
}

describe("forum public write surface", () => {
  it("uploads an attachment, replies to the parent post and verifies the new post", async () => {
    let uploaded = false;
    let posted = false;
    const client = writeClient(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/mod/forum/discuss.php") return responseAt(html, String(input));
      if (url.pathname === "/mod/forum/post.php") return responseAt(fixture("forum-reply.html"), String(input));
      if (url.pathname === "/repository/repository_ajax.php") {
        const body = init?.body as FormData;
        expect(body.get("itemid")).toBeTruthy();
        expect(body.get("sesskey")).toBe("fixture");
        expect((body.get("repo_upload_file") as File).name).toBe("roadmap-proof.txt");
        uploaded = true;
        return Response.json({ file: "roadmap-proof.txt", url: `${BASE}/draftfile.php/91/roadmap-proof.txt` });
      }
      if (url.pathname === "/lib/ajax/service.php") {
        const request = JSON.parse(String(init?.body))[0];
        if (request.methodname === "mod_forum_add_discussion_post") {
          expect(uploaded).toBe(true);
          expect(request.args).toMatchObject({ postid: 10, subject: "Week one questions", message: "Roadmap forum reply verified", messageformat: 2, options: [{ name: "attachmentsid" }] });
          posted = true;
          return Response.json([{ error: false, data: { postid: 13, warnings: [] } }]);
        }
        expect(posted).toBe(true);
        return Response.json([{ error: false, data: JSON.parse(fixture("forum-posts.json")) }]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const result = await client.replyForumPost(10, "Roadmap forum reply verified", [{ name: "roadmap-proof.txt", bytes: new TextEncoder().encode("Real lab attachment verification.") }]);
    expect(result).toEqual({ id: 13, discussion_id: 7, parent_id: 10, url: `${BASE}/mod/forum/discuss.php?d=7#p13` });
    const discussion = await client.getForumDiscussion(7, { group: false });
    expect(discussion.posts.find(post => post.id === 13)?.attachments).toEqual([{ name: "roadmap-proof.txt", size: 33, url: `${BASE}/pluginfile.php/88/mod_forum/attachment/13/roadmap-proof.txt?forcedownload=1` }]);
  });

  it("creates a new discussion through Moodle's form and verifies it after the forum redirect", async () => {
    let posted = false;
    const client = writeClient(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/mod/forum/view.php") return responseAt(fixture(posted ? "forum-unsubscribed.html" : "forum-before.html"), String(input));
      if (url.pathname === "/mod/forum/post.php" && init?.method !== "POST") return responseAt(fixture("forum-new.html"), String(input));
      if (url.pathname === "/mod/forum/post.php") {
        const body = init?.body as URLSearchParams;
        expect(body.get("subject")).toBe("Roadmap verification discussion");
        expect(body.get("message[text]")).toBe("First paragraph.\n\nSecond paragraph.");
        expect(body.get("message[format]")).toBe("2");
        expect(body.has("tags[]")).toBe(false);
        expect(body.get("sesskey")).toBe("fixture");
        posted = true;
        return responseAt(fixture("forum-post-result.html"), String(input));
      }
      if (url.pathname === "/lib/ajax/service.php") return Response.json([{ error: false, data: { posts: [{ id: 17, discussionid: 12, parentid: 0, subject: "Roadmap verification discussion", message: "First paragraph.\n\nSecond paragraph." }] } }]);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    expect(await client.createForumDiscussion(66, "Roadmap verification discussion", "First paragraph.\n\nSecond paragraph.")).toEqual({ id: 17, discussion_id: 12, parent_id: 0, url: `${BASE}/mod/forum/discuss.php?d=12#p17` });
  });

  it("subscribes and unsubscribes the forum once, preserving idempotence", async () => {
    let subscribed = false;
    let changes = 0;
    const client = writeClient(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/lib/ajax/service.php") return Response.json([{ error: false, data: [
        { stringid: "subscribe", component: "forum", string: "Subscribe to forum" },
        { stringid: "unsubscribe", component: "forum", string: "Unsubscribe from forum" },
      ] }]);
      if (url.pathname === "/mod/forum/view.php") return responseAt(fixture(subscribed ? "forum-subscribed.html" : "forum-unsubscribed.html"), String(input));
      if (url.pathname === "/mod/forum/subscribe.php") {
        expect(init?.method).toBe("POST");
        const body = init?.body as URLSearchParams;
        expect(body.get("id")).toBe("12");
        expect(body.has("d")).toBe(false);
        expect(body.get("sesskey")).toBe("fixture");
        expect(url.searchParams.has("sesskey")).toBe(false);
        subscribed = !subscribed;
        changes++;
        return responseAt("", `${BASE}/mod/forum/view.php?id=66`);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    expect(await client.setForumSubscription(66, true)).toEqual({ forum_id: 66, subscribed: true });
    await client.setForumSubscription(66, true);
    expect(changes).toBe(1);
    expect(await client.setForumSubscription(66, false)).toEqual({ forum_id: 66, subscribed: false });
    expect(changes).toBe(2);
  });
});
