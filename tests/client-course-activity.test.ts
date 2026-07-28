import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { MoodleAPIError, MoodleClient, type AjaxCall } from "../src/client";
import { ENV_MOODLE_BASE_URL, ENV_MOODLE_SESSION } from "../src/constants";
import { resolveCourseReference, parseActivityReference, resolveTopLevelUrl } from "../src/url-resolver";

const BASE_URL = "https://school.example.edu";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function jsonFixture(name: string): unknown {
  return JSON.parse(fixture(name));
}

interface SeenRequest {
  url: string;
  init?: RequestInit;
}

function installFetch(routes: Array<(request: SeenRequest) => Response | undefined>) {
  const seen: SeenRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(input), init };
    seen.push(request);
    for (const route of routes) {
      const response = route(request);
      if (response) {
        return response;
      }
    }
    throw new Error(`Unexpected fetch: ${request.url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { seen, fetchMock };
}

function dashboardRoute(request: SeenRequest): Response | undefined {
  if (request.url === `${BASE_URL}/my/`) {
    return htmlResponse(fixture("dashboard.html"));
  }
  return undefined;
}

function ajaxRoute(methodname: string, data: unknown): (request: SeenRequest) => Response | undefined {
  return (request) => {
    const url = new URL(request.url);
    if (request.init?.method === "POST" && url.pathname === "/lib/ajax/service.php" && url.searchParams.get("info")?.includes(methodname)) {
      return jsonResponse([{ index: 0, error: false, data }]);
    }
    return undefined;
  };
}

function ajaxErrorRoute(methodname: string, errorcode = "servicenotavailable"): (request: SeenRequest) => Response | undefined {
  return (request) => {
    const url = new URL(request.url);
    if (request.init?.method === "POST" && url.pathname === "/lib/ajax/service.php" && url.searchParams.get("info")?.includes(methodname)) {
      return jsonResponse([{ index: 0, error: true, exception: { message: "Web service is not available", errorcode } }]);
    }
    return undefined;
  };
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("MoodleClient course/activity modules", () => {
  it("initializes the authenticated session before loading a forum discussion", async () => {
    const { seen } = installFetch([
      dashboardRoute,
      ajaxRoute("mod_forum_get_discussion_posts", {
        courseid: 101,
        forumid: 501,
        posts: [{
          id: 9101,
          discussionid: 7001,
          subject: "Exam deadline questions",
          message: '<p>See the <a href="/mod/resource/view.php?id=55">schedule</a>.</p>',
          author: { id: 12, fullname: "Alice Example", urls: {} },
          urls: { view: `${BASE_URL}/mod/forum/discuss.php?d=7001#p9101` },
        }],
      }),
      (request) => request.url === `${BASE_URL}/mod/forum/discuss.php?d=7001`
        ? htmlResponse(fixture("forum-discussion.html"))
        : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const discussion = await client.getForumDiscussion(7001);

    expect(seen[0].url).toBe(`${BASE_URL}/my/`);
    expect(discussion.posts[0].links).toEqual([{ text: "schedule", url: `${BASE_URL}/mod/resource/view.php?id=55` }]);
  });

  it("loads courses through the primary AJAX function and resolves course references", async () => {
    installFetch([dashboardRoute, ajaxRoute("core_enrol_get_users_courses", jsonFixture("courses.json"))]);
    const client = new MoodleClient(BASE_URL, "session");

    const courses = await client.getCourses();

    expect(courses).toEqual([
      { id: 101, shortname: "MATH101", fullname: "Mathematics 101", category: 4, visible: true, startdate: 1700000000 },
      { id: 202, shortname: "MATH102", fullname: "Mathematics 102", category: 4, visible: false, startdate: 1700000100 },
    ]);
    expect(resolveCourseReference("101", courses)).toBe(101);
    expect(resolveCourseReference("102", courses)).toBe(102);
    expect(resolveCourseReference("MATH101", courses)).toBe(101);
    expect(() => resolveCourseReference("Mathematics", courses)).toThrow(/ambiguous/i);
    expect(() => resolveCourseReference("Physics", courses)).toThrow(/Could not find/);
  });

  it("falls back to the timeline courses API when the primary course API is unavailable", async () => {
    const { seen } = installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_enrol_get_users_courses"),
      (request) => {
        if (request.init?.method !== "POST" || !request.url.includes("core_course_get_enrolled_courses_by_timeline_classification")) {
          return undefined;
        }
        const body = JSON.parse(String(request.init.body)) as AjaxCall[];
        const offset = body[0]?.args?.offset;
        return jsonResponse([
          {
            index: 0,
            error: false,
            data: offset === 0 ? { courses: jsonFixture("courses.json"), nextoffset: 100 } : { courses: [], nextoffset: 100 },
          },
        ]);
      },
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const courses = await client.getCourses();

    expect(courses).toHaveLength(2);
    expect(seen.filter((request) => request.init?.method === "POST")).toHaveLength(3);
  });

  it("loads course contents through AJAX and exposes a flattened activity list", async () => {
    installFetch([dashboardRoute, ajaxRoute("core_course_get_contents", jsonFixture("course-contents.json"))]);
    const client = new MoodleClient(BASE_URL, "session");

    const sections = await client.getCourseContents(101);
    const activities = await client.getActivities(101);

    expect(sections[0].activities).toHaveLength(2);
    expect(activities.map((activity) => activity.name)).toEqual(["Syllabus", "Quiz 1"]);
  });

  it("scrapes course contents when the course contents AJAX function is unavailable", async () => {
    installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_contents"),
      (request) => (request.url === `${BASE_URL}/course/view.php?id=101` ? htmlResponse(fixture("course-page.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/course/view.php?id=101&section=1` ? htmlResponse(fixture("course-section-1.html")) : undefined),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const sections = await client.getCourseContents(101);

    expect(sections).toEqual([
      { id: 10, name: "General", section: 0, visible: true, summary: "General resources", activities: [] },
      {
        id: 11,
        name: "Week 1",
        section: 1,
        visible: true,
        summary: "Start here",
        activities: [
          {
            id: 21,
            name: "Syllabus",
            modname: "resource",
            url: "https://school.example.edu/mod/resource/view.php?id=21",
            visible: true,
            description: "Read first",
          },
          {
            id: 22,
            name: "Quiz 1",
            modname: "quiz",
            url: "https://school.example.edu/mod/quiz/view.php?id=22",
            visible: false,
            description: "",
          },
        ],
      },
    ]);
  });

  it("uses one batched AJAX POST for overview and preserves per-entry errors", async () => {
    const { seen } = installFetch([
      dashboardRoute,
      (request) => {
        if (request.init?.method !== "POST") {
          return undefined;
        }
        const body = JSON.parse(String(request.init.body)) as AjaxCall[];
        if (body.map((call) => call.methodname).join(",") === "ok_method,bad_method") {
          return jsonResponse([
            { index: 0, error: false, data: { ok: true } },
            { index: 1, error: true, exception: { message: "Bad method", errorcode: "servicenotavailable" } },
          ]);
        }
        expect(body.map((call) => call.methodname)).toEqual([
          "core_enrol_get_users_courses",
          "core_calendar_get_action_events_by_timesort",
          "message_popup_get_popup_notifications",
          "core_message_get_conversation_counts",
          "core_message_get_unread_conversation_counts",
        ]);
        return jsonResponse([
          { index: 0, error: false, data: jsonFixture("courses.json") },
          {
            index: 1,
            error: false,
            data: {
              events: [
                {
                  id: 301,
                  name: "Quiz 1 is due",
                  activityname: "Quiz 1",
                  modulename: "quiz",
                  course: { id: 101, fullname: "Mathematics 101", progress: 42 },
                  timesort: 1760000000,
                  action: { actionable: true, name: "Attempt quiz", url: `${BASE_URL}/mod/quiz/view.php?id=22` },
                  url: `${BASE_URL}/mod/quiz/view.php?id=22`,
                  eventtype: "due",
                },
              ],
            },
          },
          { index: 2, error: true, exception: { message: "Notifications disabled", errorcode: "servicenotavailable" } },
          { index: 3, error: false, data: { favourites: 1, types: { "1": 2 } } },
          { index: 4, error: false, data: { favourites: 0, types: { "1": 1 } } },
        ]);
      },
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const overview = await client.getOverview();

    expect(seen.filter((request) => request.init?.method === "POST")).toHaveLength(1);
    expect(overview.courses).toHaveLength(2);
    expect(overview.todo).toHaveLength(1);
    expect(overview.errors).toEqual(["notifications: Notifications disabled"]);

    const results = await client.callBatch([
      { methodname: "ok_method", args: {} },
      { methodname: "bad_method", args: {} },
    ]);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    if (!results[1].ok) {
      expect(results[1].error).toBeInstanceOf(MoodleAPIError);
    }
  });

  it("scrapes grades and returns an empty grade report when no grade page is usable", async () => {
    installFetch([
      dashboardRoute,
      (request) => (request.url === `${BASE_URL}/course/view.php?id=101` ? htmlResponse(fixture("course-page.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/grade/report/user/index.php?id=101` ? htmlResponse(fixture("grades.html")) : undefined),
      (request) => (request.url.includes("/grade/") || request.url.includes("/course/user.php") ? htmlResponse("<html></html>", 404) : undefined),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const grades = await client.getCourseGrades(101);

    expect(grades.course_name).toBe("Mathematics 101");
    expect(grades.total_grade).toBe("73.00");
    expect(grades.items[0]).toMatchObject({ name: "Quiz 1", grade: "8.00", feedback: "Good" });

    installFetch([
      dashboardRoute,
      (request) => (request.url === `${BASE_URL}/course/view.php?id=404` ? htmlResponse("<html><h1>No Grades</h1></html>") : undefined),
      (request) => (request.url.includes("/grade/") || request.url.includes("/course/user.php") ? htmlResponse("<html></html>", 404) : undefined),
    ]);
    const empty = await new MoodleClient(BASE_URL, "session").getCourseGrades(404);
    expect(empty).toMatchObject({ course_id: 404, items: [] });
  });

  it("scrapes six activity detail pages and parses activity references", async () => {
    installFetch([
      dashboardRoute,
      ajaxRoute("core_course_get_course_module", { cm: { id: 31, modname: "assign" } }),
      (request) => (request.url === `${BASE_URL}/mod/assign/view.php?id=31` ? htmlResponse(fixture("assign.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/quiz/view.php?id=32` ? htmlResponse(fixture("quiz.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/resource/view.php?id=33` ? htmlResponse(fixture("resource.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/url/view.php?id=34` ? htmlResponse(fixture("link.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/page/view.php?id=35` ? htmlResponse(fixture("page.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/folder/view.php?id=36` ? htmlResponse(fixture("folder.html")) : undefined),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(client.getAssignment(31)).resolves.toMatchObject({ name: "Essay 1", due_pretty: "Friday, 10 May 2026, 5:00 PM" });
    await expect(client.getQuiz(32)).resolves.toMatchObject({ name: "Quiz 1", attempts_allowed: "2" });
    await expect(client.getResource(33)).resolves.toMatchObject({ target_name: "slides.pdf" });
    await expect(client.getLink(34)).resolves.toMatchObject({ target_url: "https://example.com/reading" });
    await expect(client.getPage(35)).resolves.toMatchObject({ content_text: "Remember the integration rules." });
    await expect(client.getFolder(36)).resolves.toMatchObject({ files: ["chapter-1.pdf", "chapter-2.pdf"] });
    await expect(client.getActivity(31)).resolves.toMatchObject({ id: 31, name: "Essay 1", type: "assign" });

    expect(parseActivityReference(`${BASE_URL}/mod/assign/view.php?id=31`, { label: "Assignment", path: "/mod/assign/view.php" })).toBe(31);
    expect(parseActivityReference("32", { label: "Quiz", path: "/mod/quiz/view.php" })).toBe(32);
  });

  it("resolves top-level Moodle URLs and rejects unsupported paths", () => {
    expect(resolveTopLevelUrl({ baseUrl: BASE_URL, target: `${BASE_URL}/mod/assign/view.php?id=31` })).toEqual({
      commandName: "assign",
      kwargs: { assign: "31", asJson: false, asYaml: false },
    });
    expect(resolveTopLevelUrl({ baseUrl: BASE_URL, target: `${BASE_URL}/course/view.php?id=101` })).toEqual({
      commandName: "course",
      kwargs: { course: "101", asJson: false, asYaml: false },
    });
    expect(() => resolveTopLevelUrl({ baseUrl: BASE_URL, target: `${BASE_URL}/calendar/view.php?view=month` })).toThrow(
      /Unsupported Moodle URL/,
    );
  });

  it("prints CLI JSON parity for courses, course sections, and flat activities", async () => {
    const fetchImpl = cliFetch([
      dashboardRoute,
      ajaxRoute("core_enrol_get_users_courses", jsonFixture("courses.json")),
      ajaxRoute("core_course_get_contents", jsonFixture("course-contents.json")),
    ]);

    const courses = await runJsonCommand(["courses", "--json", "--fields", "id,shortname"], fetchImpl);
    expect(courses.code).toBe(0);
    expect(JSON.parse(courses.stdout)).toEqual([
      { id: 101, shortname: "MATH101" },
      { id: 202, shortname: "MATH102" },
    ]);

    const course = await runJsonCommand(["units", "show", "101", "--json"], fetchImpl);
    expect(course.code).toBe(0);
    const courseJson = JSON.parse(course.stdout);
    expect(courseJson[0].id).toBe(11);
    expect(courseJson[0].name).toBe("Introduction");
    expect(courseJson[0].activities[0]).toMatchObject({ id: 21, name: "Syllabus" });

    const activities = await runJsonCommand(["activities", "101", "--json"], fetchImpl);
    expect(activities.code).toBe(0);
    expect(JSON.parse(activities.stdout)).toEqual([
      { id: 21, name: "Syllabus", modname: "resource", url: `${BASE_URL}/mod/resource/view.php?id=21`, visible: true, description: "Read first" },
      { id: 22, name: "Quiz 1", modname: "quiz", url: `${BASE_URL}/mod/quiz/view.php?id=22`, visible: false, description: "" },
    ]);
  });

  it("prints CLI JSON parity for todo, alerts, and overview", async () => {
    const fetchImpl = cliFetch([
      dashboardRoute,
      (request) => {
        if (request.init?.method !== "POST") {
          return undefined;
        }
        const body = JSON.parse(String(request.init.body)) as AjaxCall[];
        const methods = body.map((call) => call.methodname);
        if (methods.length === 1 && methods[0] === "core_calendar_get_action_events_by_timesort") {
          return jsonResponse([{ index: 0, error: false, data: todoPayload() }]);
        }
        if (methods.join(",") === "message_popup_get_popup_notifications,core_message_get_conversation_counts,core_message_get_unread_conversation_counts") {
          return jsonResponse(alertBatch());
        }
        if (methods.join(",") === "core_enrol_get_users_courses,core_calendar_get_action_events_by_timesort,message_popup_get_popup_notifications,core_message_get_conversation_counts,core_message_get_unread_conversation_counts") {
          return jsonResponse([{ index: 0, error: false, data: jsonFixture("courses.json") }, { index: 1, error: false, data: todoPayload() }, ...alertBatch().map((item, index) => ({ ...item, index: index + 2 }))]);
        }
        return undefined;
      },
    ]);

    const todo = await runJsonCommand(["todo", "--limit", "5", "--json", "--fields", "id,name"], fetchImpl);
    expect(todo.code).toBe(0);
    expect(JSON.parse(todo.stdout)).toEqual([{ id: 301, name: "Quiz 1 is due" }]);

    const alerts = await runJsonCommand(["alerts", "--json"], fetchImpl);
    expect(alerts.code).toBe(0);
    expect(JSON.parse(alerts.stdout)).toMatchObject({ notification_count: 1, direct_message_count: 2, unread_direct_message_count: 1 });

    const overview = await runJsonCommand(["overview", "--json"], fetchImpl);
    expect(overview.code).toBe(0);
    const overviewJson = JSON.parse(overview.stdout);
    expect(overviewJson.user.userid).toBe(7);
    expect(overviewJson.courses[0].id).toBe(101);
    expect(overviewJson.todo[0].id).toBe(301);
    expect(overviewJson.alerts.notification_count).toBe(1);
  });

  it("routes top-level URLs with structured output options", async () => {
    const fetchImpl = cliFetch([
      dashboardRoute,
      (request) => (request.url === `${BASE_URL}/mod/assign/view.php?id=31` ? htmlResponse(fixture("assign.html")) : undefined),
    ]);

    const result = await runJsonCommand([`${BASE_URL}/mod/assign/view.php?id=31`, "--json", "--fields", "id,name"], fetchImpl);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ id: 31, name: "Essay 1" });
  });

  it("resolves the activity type for activities show", async () => {
    const fetchImpl = cliFetch([
      dashboardRoute,
      ajaxRoute("core_course_get_course_module", { cm: { id: 31, modname: "assign" } }),
      (request) => (request.url === `${BASE_URL}/mod/assign/view.php?id=31` ? htmlResponse(fixture("assign.html")) : undefined),
    ]);

    const result = await runJsonCommand(["activities", "show", "31", "--json"], fetchImpl);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 31, name: "Essay 1", type: "assign" });
  });

  it("returns usage errors for invalid URL --fields", async () => {
    const fetchImpl = cliFetch([
      dashboardRoute,
      (request) => (request.url === `${BASE_URL}/mod/assign/view.php?id=31` ? htmlResponse(fixture("assign.html")) : undefined),
    ]);

    const invalid = await runJsonCommand([`${BASE_URL}/mod/assign/view.php?id=31`, "--json", "--fields", "missing"], fetchImpl);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ error: { code: "usage" }, exit_code: 2 });
    expect(invalid.stderr).toContain("Valid fields");

    const missing = await runJsonCommand([`${BASE_URL}/mod/assign/view.php?id=31`, "--json", "--fields"], fetchImpl);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stderr)).toMatchObject({ error: { code: "usage", message: expect.stringContaining("fields") }, exit_code: 2 });
  });

  it("applies --fields to forum search", async () => {
    const fetchImpl = cliFetch([
      dashboardRoute,
      ajaxRoute("core_enrol_get_users_courses", jsonFixture("courses.json")),
      ajaxRoute("core_course_get_contents", []),
      (request) => {
        if (request.init?.method !== "POST" || !request.url.includes("mod_forum_get_discussion_posts")) {
          return undefined;
        }
        const body = JSON.parse(String(request.init.body)) as AjaxCall[];
        const discussionId = Number(body[0]?.args?.discussionid ?? 0);
        return jsonResponse([{
          index: 0,
          error: false,
          data: {
            courseid: 101,
            forumid: 501,
            posts: [{
              id: discussionId + 100,
              discussionid: discussionId,
              subject: discussionId === 9001 ? "Exam deadline questions" : "Lecture recap",
              message: "",
              author: { id: 12, fullname: "Alice Example", urls: { profile: `${BASE_URL}/user/view.php?id=12` } },
              timecreated: discussionId === 9001 ? 200 : 100,
              unread: false,
              urls: { view: `${BASE_URL}/mod/forum/discuss.php?d=${discussionId}#p${discussionId + 100}` },
            }],
          },
        }]);
      },
      (request) => {
        if (request.url === `${BASE_URL}/mod/forum/view.php?id=501`) return htmlResponse(fixture("forum-view-default-grouped.html"));
        if (request.url === `${BASE_URL}/mod/forum/view.php?id=501&group=10`) return htmlResponse(fixture("forum-view-group-a.html"));
        if (request.url === `${BASE_URL}/mod/forum/view.php?id=501&group=20`) return htmlResponse(fixture("forum-view-group-b.html"));
        return undefined;
      },
    ]);

    const result = await runJsonCommand([
      "forums",
      "search",
      "deadline",
      "--forum",
      "501",
      "--titles-only",
      "--limit",
      "1",
      "--json",
      "--fields",
      "discussion_id,discussion_subject",
    ], fetchImpl);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual([{ discussion_id: 9001, discussion_subject: "Exam deadline questions" }]);
  });
});

function cliFetch(routes: Array<(request: SeenRequest) => Response | undefined>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(input), init };
    for (const route of routes) {
      const response = route(request);
      if (response) {
        return response;
      }
    }
    throw new Error(`Unexpected fetch: ${request.url}`);
  }) as typeof fetch;
}

async function runJsonCommand(args: string[], fetchImpl: typeof fetch): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = buffer();
  const stderr = buffer();
  const code = await runCli(["node", "moodle", ...args], {
    env: { [ENV_MOODLE_BASE_URL]: BASE_URL, [ENV_MOODLE_SESSION]: "cookie" },
    fetchImpl,
    stdout,
    stderr,
    stdin: { isTTY: false } as NodeJS.ReadStream,
    homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-run-")),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function buffer() {
  let value = "";
  return {
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text() {
      return value;
    },
  };
}

function todoPayload() {
  return {
    events: [
      {
        id: 301,
        name: "Quiz 1 is due",
        activityname: "Quiz 1",
        modulename: "quiz",
        course: { id: 101, fullname: "Mathematics 101", progress: 42 },
        timesort: 1760000000,
        action: { actionable: true, name: "Attempt quiz", url: `${BASE_URL}/mod/quiz/view.php?id=22` },
        url: `${BASE_URL}/mod/quiz/view.php?id=22`,
        eventtype: "due",
      },
    ],
  };
}

function alertBatch() {
  return [
    {
      index: 0,
      error: false,
      data: {
        notifications: [
          {
            id: 401,
            subject: "Message subject",
            shortenedsubject: "Message",
            eventtype: "message",
            component: "message",
            timecreated: 1760000100,
            timecreatedpretty: "Today",
            read: false,
            contexturl: `${BASE_URL}/message`,
            contexturlname: "Messages",
          },
        ],
      },
    },
    { index: 1, error: false, data: { favourites: 1, types: { "1": 2, "2": 0, "3": 0 } } },
    { index: 2, error: false, data: { favourites: 0, types: { "1": 1, "2": 0, "3": 0 } } },
  ];
}
