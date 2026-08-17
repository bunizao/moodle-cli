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

  it("keeps overview sources independent when Moodle truncates a failed batch", async () => {
    installFetch([
      (request) => {
        if (request.init?.method !== "POST") return undefined;
        const body = JSON.parse(String(request.init.body)) as AjaxCall[];
        const methods = body.map((call) => call.methodname);
        if (methods.length > 1 && methods[0] === "core_enrol_get_users_courses") {
          return jsonResponse([{
            index: 0,
            error: true,
            exception: { message: "Web service is not available", errorcode: "servicenotavailable" },
          }]);
        }
        if (methods[0] === "core_webservice_get_site_info") {
          return jsonResponse([{ index: 0, error: false, data: {
            userid: 7,
            fullname: "Alice Example",
            sitename: "Example Moodle",
            siteurl: BASE_URL,
          } }]);
        }
        if (methods[0] === "core_enrol_get_users_courses") {
          return jsonResponse([{
            index: 0,
            error: true,
            exception: { message: "Web service is not available", errorcode: "servicenotavailable" },
          }]);
        }
        if (methods[0] === "core_course_get_enrolled_courses_by_timeline_classification") {
          const offset = body[0]?.args?.offset;
          return jsonResponse([{ index: 0, error: false, data: {
            courses: offset === 0 ? jsonFixture("courses.json") : [],
            nextoffset: 100,
          } }]);
        }
        if (methods[0] === "core_calendar_get_action_events_by_timesort") {
          return jsonResponse([{ index: 0, error: false, data: todoPayload() }]);
        }
        if (methods.join(",") === "message_popup_get_popup_notifications,core_message_get_conversation_counts,core_message_get_unread_conversation_counts") {
          return jsonResponse(alertBatch());
        }
        return undefined;
      },
    ]);
    const client = new MoodleClient(BASE_URL, {
      cookie: { name: "MoodleSession", value: "session" },
      sesskey: "sess",
      userid: 7,
    });

    const overview = await client.getOverview(5, 14, 5);

    expect(overview.user.fullname).toBe("Alice Example");
    expect(overview.courses).toHaveLength(2);
    expect(overview.todo).toHaveLength(1);
    expect(overview.alerts).toMatchObject({ direct_message_count: 2 });
    expect(overview.errors).toEqual([]);
  });

  it("loads course contents through AJAX and exposes a flattened activity list", async () => {
    installFetch([dashboardRoute, ajaxRoute("core_course_get_contents", jsonFixture("course-contents.json"))]);
    const client = new MoodleClient(BASE_URL, "session");

    const sections = await client.getCourseContents(101);
    const activities = await client.getActivities(101);

    expect(sections[0].activities).toHaveLength(2);
    expect(activities.map((activity) => activity.name)).toEqual(["Syllabus", "Quiz 1"]);
  });

  it("falls back to the modern course-format state service", async () => {
    installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_contents"),
      ajaxRoute("core_courseformat_get_state", JSON.stringify({
        section: [
          { id: "11", section: 1, title: "Week 1", cmlist: ["21", "22"], visible: true },
          { id: "12", section: 2, title: "Week 2", cmlist: ["23"], visible: false },
          { id: "13", section: 3, title: "Week 3", cmlist: [], visible: true },
        ],
        cm: [
          { id: "21", name: "Syllabus", sectionid: "11", module: "resource", url: `${BASE_URL}/mod/resource/view.php?id=21`, visible: true, uservisible: true },
          { id: "22", name: "Quiz 1", sectionid: "11", plugin: "mod_quiz", url: "/mod/quiz/view.php?id=22", visible: true, uservisible: true, accessvisible: false },
          { id: "23", name: "Hidden page", sectionid: "12", module: "page", url: "/mod/page/view.php?id=23", visible: false, uservisible: false },
          { id: "24", name: "Omitted activity", sectionid: "13", module: "label", visible: true, uservisible: true },
        ],
      })),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const sections = await client.getCourseContents(101);

    expect(sections).toEqual([
      {
        id: 11,
        name: "Week 1",
        section: 1,
        visible: true,
        summary: "",
        activities: [
          { id: 21, name: "Syllabus", modname: "resource", url: `${BASE_URL}/mod/resource/view.php?id=21`, visible: true, description: "" },
          { id: 22, name: "Quiz 1", modname: "quiz", url: `${BASE_URL}/mod/quiz/view.php?id=22`, visible: true, description: "" },
        ],
      },
      {
        id: 12,
        name: "Week 2",
        section: 2,
        visible: false,
        summary: "",
        activities: [
          { id: 23, name: "Hidden page", modname: "page", url: `${BASE_URL}/mod/page/view.php?id=23`, visible: false, description: "" },
        ],
      },
      {
        id: 13,
        name: "Week 3",
        section: 3,
        visible: true,
        summary: "",
        activities: [],
      },
    ]);
  });

  it("uses the module course hint instead of scanning every enrolled course", async () => {
    const courses = Array.from({ length: 30 }, (_, index) => ({
      id: 101 + index,
      shortname: `C${index + 1}`,
      fullname: `Course ${index + 1}`,
      category: 1,
      visible: true,
      startdate: 0,
    }));
    const { seen } = installFetch([
      dashboardRoute,
      ajaxRoute("core_course_get_course_module", { cm: { id: 24, course: 101, modname: "lti" } }),
      ajaxRoute("core_course_get_contents", [{
        id: 11,
        name: "Week 1",
        section: 1,
        visible: true,
        summary: "",
        modules: [{ id: 24, name: "Reading list", modname: "lti", url: `${BASE_URL}/mod/lti/view.php?id=24`, visible: true }],
      }]),
      ajaxRoute("core_enrol_get_users_courses", courses),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(client.getActivity(24)).resolves.toMatchObject({ id: 24, name: "Reading list", type: "lti" });

    const methods = seen.filter((request) => request.init?.method === "POST")
      .flatMap((request) => (JSON.parse(String(request.init?.body)) as AjaxCall[]).map((call) => call.methodname));
    expect(methods).toEqual(["core_course_get_course_module", "core_course_get_contents"]);
  });

  it("returns not found when one unrelated course cannot be searched", async () => {
    installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_course_module"),
      ajaxRoute("core_enrol_get_users_courses", [
        { id: 101, shortname: "C1", fullname: "Course 1", category: 1, visible: true, startdate: 0 },
        { id: 102, shortname: "C2", fullname: "Course 2", category: 1, visible: true, startdate: 0 },
      ]),
      (request) => {
        if (!request.url.includes("core_course_get_contents")) return undefined;
        const body = JSON.parse(String(request.init?.body)) as AjaxCall[];
        return jsonResponse(body.map((call, index) => call.args?.courseid === 101
          ? { index, error: true, exception: { message: "Course access denied", errorcode: "accessexception" } }
          : { index, error: false, data: [] }));
      },
      ajaxRoute("core_courseformat_get_state", JSON.stringify({
        section: [{ id: "11", section: 1, title: "Week 1", cmlist: [] }],
        cm: [],
      })),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(client.getActivity(999)).rejects.toThrow(
      "Activity 999 was not found in the authenticated user's courses.",
    );
  });

  it("batches activity discovery across every enrolled course", async () => {
    const courses = Array.from({ length: 25 }, (_, index) => ({
      id: 101 + index,
      shortname: `C${index + 1}`,
      fullname: `Course ${index + 1}`,
      category: 1,
      visible: true,
      startdate: 0,
    }));
    const { seen } = installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_course_module"),
      ajaxRoute("core_enrol_get_users_courses", courses),
      (request) => {
        if (!request.url.includes("core_course_get_contents")) return undefined;
        const body = JSON.parse(String(request.init?.body)) as AjaxCall[];
        return jsonResponse(body.map((call, index) => ({
          index,
          error: false,
          data: call.args?.courseid === 125
            ? [{
                id: 11,
                name: "Week 1",
                section: 1,
                visible: true,
                summary: "",
                modules: [{ id: 999, name: "Late course activity", modname: "lti", url: "", visible: true }],
              }]
            : [],
        })));
      },
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(client.getActivity(999)).resolves.toMatchObject({
      id: 999,
      name: "Late course activity",
      type: "lti",
    });

    const courseRequests = seen.filter((request) => request.url.includes("core_course_get_contents"));
    expect(courseRequests).toHaveLength(2);
  });

  it("recovers omitted and reordered batch entries through course-format state", async () => {
    const courses = Array.from({ length: 3 }, (_, index) => ({
      id: 101 + index,
      shortname: `C${index + 1}`,
      fullname: `Course ${index + 1}`,
      category: 1,
      visible: true,
      startdate: 0,
    }));
    const { seen } = installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_course_module"),
      ajaxRoute("core_enrol_get_users_courses", courses),
      (request) => request.url.includes("core_course_get_contents")
        ? jsonResponse([
            { index: 2, error: false, data: [] },
            { index: 1, error: false, data: [] },
          ])
        : undefined,
      (request) => {
        if (!request.url.includes("core_courseformat_get_state")) return undefined;
        const body = JSON.parse(String(request.init?.body)) as AjaxCall[];
        return jsonResponse(body.map((call, index) => {
          const courseId = Number(call.args?.courseid);
          const hasTarget = courseId === 101;
          return {
            index,
            error: false,
            data: JSON.stringify({
              section: [{ id: String(courseId), section: 1, title: "Week 1", cmlist: hasTarget ? ["999"] : [] }],
              cm: hasTarget
                ? [{ id: "999", sectionid: String(courseId), module: "lesson", name: "Late lesson", visible: true, uservisible: true }]
                : [],
            }),
          };
        }));
      },
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(client.getActivity(999)).resolves.toMatchObject({
      id: 999,
      name: "Late lesson",
      type: "lesson",
    });

    expect(seen.filter((request) => request.url.includes("core_course_get_contents"))).toHaveLength(1);
    expect(seen.filter((request) => request.url.includes("core_courseformat_get_state"))).toHaveLength(1);
    const stateRequest = seen.find((request) => request.url.includes("core_courseformat_get_state"));
    const stateCalls = JSON.parse(String(stateRequest?.init?.body)) as AjaxCall[];
    expect(stateCalls.map((call) => call.args?.courseid)).toEqual([101]);
  });

  it("stops activity discovery when a batched course request reports session expiry", async () => {
    const { seen } = installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_course_module"),
      ajaxRoute("core_enrol_get_users_courses", [
        { id: 101, shortname: "C1", fullname: "Course 1", category: 1, visible: true, startdate: 0 },
        { id: 102, shortname: "C2", fullname: "Course 2", category: 1, visible: true, startdate: 0 },
      ]),
      (request) => request.url.includes("core_course_get_contents")
        ? jsonResponse([
            { index: 0, error: true, exception: { message: "Session expired", errorcode: "servicerequireslogin" } },
            { index: 1, error: false, data: [] },
          ])
        : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(client.getActivity(999)).rejects.toMatchObject({
      moodleErrorCode: "servicerequireslogin",
    });
    expect(seen.some((request) => request.url.includes("core_courseformat_get_state"))).toBe(false);
  });

  it("resolves activity details through course contents when module lookup is disabled", async () => {
    installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_course_module"),
      ajaxRoute("core_enrol_get_users_courses", [(jsonFixture("courses.json") as unknown[])[0]]),
      ajaxRoute("core_course_get_contents", [{
        id: 11,
        name: "Week 1",
        section: 1,
        visible: true,
        summary: "",
        modules: [
          { id: 21, name: "Syllabus", modname: "resource", url: `${BASE_URL}/mod/resource/view.php?id=21`, visible: true },
          { id: 24, name: "Reading list", modname: "lti", url: `${BASE_URL}/mod/lti/view.php?id=24`, visible: true },
        ],
      }]),
      (request) => (request.url === `${BASE_URL}/mod/resource/view.php?id=21` ? htmlResponse(fixture("resource.html")) : undefined),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(client.getActivity(21)).resolves.toMatchObject({ id: 21, type: "resource", target_name: "slides.pdf" });
    await expect(client.getActivity(24)).resolves.toEqual({
      id: 24,
      name: "Reading list",
      modname: "lti",
      url: `${BASE_URL}/mod/lti/view.php?id=24`,
      visible: true,
      description: "",
      type: "lti",
    });
  });

  it("scrapes course contents when the course contents AJAX function is unavailable", async () => {
    installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_contents"),
      ajaxErrorRoute("core_courseformat_get_state"),
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

  it("follows HTML-encoded section links when AJAX fallbacks are unavailable", async () => {
    const rootPage = fixture("course-page.html").replace("&section=1", "&amp;section=1");
    installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_contents"),
      ajaxErrorRoute("core_courseformat_get_state"),
      (request) => (request.url === `${BASE_URL}/course/view.php?id=101` ? htmlResponse(rootPage) : undefined),
      (request) => (request.url === `${BASE_URL}/course/view.php?id=101&section=1` ? htmlResponse(fixture("course-section-1.html")) : undefined),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const sections = await client.getCourseContents(101);

    expect(sections.flatMap((section) => section.activities).map((activity) => activity.name))
      .toEqual(["Syllabus", "Quiz 1"]);
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
    expect(results[0]?.ok).toBe(true);
    const failed = results[1];
    expect(failed?.ok).toBe(false);
    if (failed && !failed.ok) {
      expect(failed.error).toBeInstanceOf(MoodleAPIError);
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
    await expect(client.getResource(33)).resolves.toMatchObject({
      target_name: "slides.pdf",
      file_entries: [{
        name: "slides.pdf",
        url: `${BASE_URL}/pluginfile.php/1/slides.pdf`,
        requires_authentication: true,
      }],
    });
    await expect(client.getLink(34)).resolves.toMatchObject({
      course_id: 101,
      course_name: "Mathematics 101",
      section_name: "Week 1",
      target_url: "https://example.com/reading",
    });
    await expect(client.getPage(35)).resolves.toMatchObject({ content_text: "Remember the integration rules." });
    await expect(client.getFolder(36)).resolves.toMatchObject({
      files: ["chapter-1.pdf", "chapter-2.pdf"],
      file_entries: [
        {
          name: "chapter-1.pdf",
          url: `${BASE_URL}/pluginfile.php/a.pdf`,
          requires_authentication: true,
        },
        {
          name: "chapter-2.pdf",
          url: `${BASE_URL}/pluginfile.php/b.pdf`,
          requires_authentication: true,
        },
      ],
    });
    await expect(client.getActivity(31)).resolves.toMatchObject({ id: 31, name: "Essay 1", type: "assign" });

    expect(parseActivityReference(`${BASE_URL}/mod/assign/view.php?id=31`, { label: "Assignment", path: "/mod/assign/view.php" })).toBe(31);
    expect(parseActivityReference("32", { label: "Quiz", path: "/mod/quiz/view.php" })).toBe(32);
  });

  it.each(["page", "resource"])("surfaces Moodle's %s error message in structured CLI output", async (moduleType) => {
    const url = `${BASE_URL}/mod/${moduleType}/view.php?id=1477656`;
    const fetchImpl = cliFetch([
      dashboardRoute,
      (request) => (request.url === url ? htmlResponse(fixture("moodle-error.html"), 404) : undefined),
    ]);

    const result = await runJsonCommand([url, "--json"], fetchImpl);

    expect(result).toMatchObject({ code: 4, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "not_found",
        message: `Invalid unit module ID (HTTP 404 loading ${url})`,
      },
      exit_code: 4,
    });
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
