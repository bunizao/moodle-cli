import { describe, expect, it } from "vitest";

import {
  MAX_MCP_FILE_BYTES,
  createMoodleGateway,
  type MoodleClientPort,
} from "../src/mcp/gateway.js";

describe("Moodle gateway", () => {
  it("adapts the existing client surface to runtime-neutral Moodle operations", async () => {
    const client = fakeClient();
    const gateway = createMoodleGateway(client);

    await expect(gateway.getUser()).resolves.toMatchObject({ userid: 7, fullname: "Ada Lovelace" });
    await expect(gateway.getOverview({ todoLimit: 3, todoDays: 14, alertsLimit: 2 })).resolves.toMatchObject({
      user: { userid: 7 },
    });
    await expect(gateway.getCourse({ courseId: 101 })).resolves.toMatchObject({
      course: { id: 101, shortname: "COMP101" },
      sections: [{ id: 1, name: "Week 1" }],
    });
    await expect(gateway.listActivities({ courseId: 101 })).resolves.toEqual([
      expect.objectContaining({ id: 501, modname: "assign" }),
    ]);
    await expect(gateway.getActivity({ activityId: 501 })).resolves.toMatchObject({ id: 501, type: "assign" });
    await expect(gateway.getFile({ source: "https://moodle.example.edu/pluginfile.php/1/slides.pdf" })).resolves.toEqual({
      name: "slides.pdf",
      mimeType: "application/pdf",
      bytes: 6,
      uri: "https://moodle.example.edu/pluginfile.php/1/slides.pdf",
      blob: "c2xpZGVz",
    });
    await expect(gateway.getGrades({ courseId: 101 })).resolves.toMatchObject({ course_id: 101, total_grade: "80" });
    await expect(gateway.listForums({ courseId: 101 })).resolves.toEqual([
      expect.objectContaining({ id: 601, course_id: 101 }),
    ]);
    await expect(gateway.searchForums({ query: "exam", courseId: 101, forumId: 601, limit: 5 })).resolves.toEqual([
      expect.objectContaining({ discussion_id: 701, snippet: "Exam details" }),
    ]);
    await expect(gateway.getThread({ discussionId: 701 })).resolves.toMatchObject({ id: 701, subject: "Exam" });
  });

  it("reports a missing course at the gateway boundary", async () => {
    const gateway = createMoodleGateway({
      ...fakeClient(),
      getCourses: async () => [],
    });

    await expect(gateway.getCourse({ courseId: 404 })).rejects.toMatchObject({
      code: "MOODLE_COURSE_NOT_FOUND",
    });
  });

  it("resolves a resource activity ID before fetching its authenticated file", async () => {
    const client = {
      ...fakeClient(),
      getActivity: async () => ({
        id: 91234,
        name: "Lecture slides",
        type: "resource",
        url: "https://moodle.example.edu/mod/resource/view.php?id=91234",
        target_name: "week-1.pdf",
        target_url: "https://moodle.example.edu/pluginfile.php/1/week-1.pdf",
        file_entries: [{
          name: "week-1.pdf",
          url: "https://moodle.example.edu/pluginfile.php/1/week-1.pdf",
          requires_authentication: true,
        }],
      }) as never,
      requestAbsolute: async (url: string) => responseAt(url, "slides", { "content-type": "application/pdf" }),
    };
    const gateway = createMoodleGateway(client);

    await expect(gateway.getFile({ source: 91234 })).resolves.toMatchObject({
      name: "week-1.pdf",
      bytes: 6,
      blob: "c2xpZGVz",
    });
  });

  it("follows a same-site resource wrapper when Moodle omits file entries", async () => {
    const wrapperUrl = "https://moodle.example.edu/mod/resource/view.php?id=91235";
    const fileUrl = "https://moodle.example.edu/pluginfile.php/1/wrapper.pdf";
    const client = {
      ...fakeClient(),
      getActivity: async () => ({
        id: 91235,
        name: "Wrapper resource",
        type: "resource",
        url: wrapperUrl,
        target_name: "",
        target_url: "",
        file_entries: [],
      }) as never,
      requestAbsolute: async (url: string) => url === wrapperUrl
        ? responseAt(url, `<div class="resourceworkaround"><a href="${fileUrl}">wrapper.pdf</a></div>`, {
            "content-type": "text/html",
          })
        : responseAt(url, "slides", { "content-type": "application/pdf" }),
    };

    await expect(createMoodleGateway(client).getFile({ source: 91235 })).resolves.toMatchObject({
      name: "wrapper.pdf",
      bytes: 6,
    });
  });

  it("reports an HTML login page as an authentication failure", async () => {
    const gateway = createMoodleGateway({
      ...fakeClient(),
      requestAbsolute: async (url: string) => responseAt(url, '<form action="/login/index.php"><input name="password"></form>', {
        "content-type": "text/html",
      }),
    });

    await expect(gateway.getFile({ source: "https://moodle.example.edu/pluginfile.php/1/slides.pdf" }))
      .rejects.toMatchObject({ code: "MOODLE_AUTH_REQUIRED" });
  });

  it("rejects cross-site and oversized files before returning content", async () => {
    const client = fakeClient();
    const gateway = createMoodleGateway(client);

    await expect(gateway.getFile({ source: "https://evil.example/pluginfile.php/1/secret.pdf" }))
      .rejects.toMatchObject({ code: "MOODLE_FILE_SOURCE_INVALID" });

    const crossSiteActivity = createMoodleGateway({
      ...client,
      getActivity: async () => ({
        id: 91234,
        name: "External file",
        type: "resource",
        url: "https://moodle.example.edu/mod/resource/view.php?id=91234",
        target_name: "secret.pdf",
        target_url: "https://evil.example/secret.pdf",
        file_entries: [{
          name: "secret.pdf",
          url: "https://evil.example/secret.pdf",
          requires_authentication: false,
        }],
      }) as never,
    });
    await expect(crossSiteActivity.getFile({ source: 91234 }))
      .rejects.toMatchObject({ code: "MOODLE_FILE_SOURCE_INVALID" });

    const oversized = createMoodleGateway({
      ...client,
      requestAbsolute: async () => new Response("", {
        headers: { "content-length": String(MAX_MCP_FILE_BYTES + 1), "content-type": "application/pdf" },
      }),
    });
    await expect(oversized.getFile({ source: "https://moodle.example.edu/pluginfile.php/1/large.pdf" }))
      .rejects.toMatchObject({ code: "MOODLE_FILE_TOO_LARGE" });

    const streamedOversized = createMoodleGateway({
      ...client,
      requestAbsolute: async () => new Response(new Uint8Array(MAX_MCP_FILE_BYTES + 1), {
        headers: { "content-type": "application/pdf" },
      }),
    });
    await expect(streamedOversized.getFile({ source: "https://moodle.example.edu/pluginfile.php/1/large.pdf" }))
      .rejects.toMatchObject({ code: "MOODLE_FILE_TOO_LARGE" });
  });
});

function fakeClient(): MoodleClientPort {
  const user = {
    userid: 7,
    username: "ada",
    fullname: "Ada Lovelace",
    sitename: "Example Moodle",
    siteurl: "https://moodle.example.edu",
  };
  const course = {
    id: 101,
    shortname: "COMP101",
    fullname: "Computing",
    category: 1,
    visible: true,
    startdate: 1,
  };
  const activity = {
    id: 501,
    name: "Assignment 1",
    modname: "assign",
    url: "https://moodle.example.edu/mod/assign/view.php?id=501",
    visible: true,
    description: "",
  };
  const section = { id: 1, name: "Week 1", section: 1, visible: true, summary: "", activities: [activity] };

  return {
    baseUrl: "https://moodle.example.edu",
    getSiteInfo: async () => user,
    getOverview: async () => ({ user, courses: [course], todo: [], errors: [] }),
    getCourses: async () => [course],
    getCourseContents: async () => [section],
    getActivities: async () => [activity],
    getActivity: async () => ({
      id: 501,
      name: "Assignment 1",
      course_id: 101,
      course_name: "Computing",
      section_name: "Week 1",
      due_pretty: "Tomorrow",
      submission_status: "Not submitted",
      grading_status: "Not graded",
      time_remaining: "1 day",
      grade: "-",
      url: activity.url,
      type: "assign",
    }),
    requestAbsolute: async (url) => responseAt(url, "slides", {
      "content-disposition": 'attachment; filename="slides.pdf"',
      "content-type": "application/pdf",
    }),
    getCourseGrades: async () => ({
      course_id: 101,
      course_name: "Computing",
      learner_name: "Ada Lovelace",
      total_grade: "80",
      total_range: "0-100",
      total_percentage: "80%",
      items: [],
    }),
    getForums: async () => [{
      id: 601,
      name: "Announcements",
      course_id: 101,
      course_name: "Computing",
      url: "https://moodle.example.edu/mod/forum/view.php?id=601",
    }],
    searchForumContent: async () => [{
      course_id: 101,
      course_name: "Computing",
      forum_id: 601,
      forum_name: "Announcements",
      group_id: 0,
      group_name: "",
      discussion_id: 701,
      discussion_subject: "Exam",
      post_id: 702,
      author_name: "Teacher",
      matched_in: "post_body",
      snippet: "Exam details",
      unread: true,
      time_created: 1,
      url: "https://moodle.example.edu/mod/forum/discuss.php?d=701",
    }],
    getForumDiscussion: async () => ({
      id: 701,
      subject: "Exam",
      course_id: 101,
      forum_id: 601,
      group_id: 0,
      group_name: "",
      url: "https://moodle.example.edu/mod/forum/discuss.php?d=701",
      posts: [],
    }),
  };
}

function responseAt(url: string, body: BodyInit, headers: HeadersInit): Response {
  const response = new Response(body, { headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
