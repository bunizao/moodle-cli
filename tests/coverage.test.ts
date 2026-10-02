import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { checkCoverage, type CoverageCheck } from "../src/coverage.js";
import { intentContracts } from "../src/intent-contract.js";
import { createIntentService } from "../src/intents.js";
import type { MoodleGateway } from "../src/mcp/gateway.js";
import { createMoodleClientCore } from "../src/moodle-client-core.js";
import { VERSION } from "../src/version.js";
import { fixtureGateway, sections, siteUser, units } from "./fixtures/intent-site.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

async function collect(gateway: MoodleGateway, takeDisabled?: () => string[]): Promise<CoverageCheck[]> {
  const checks: CoverageCheck[] = [];
  for await (const check of checkCoverage(createIntentService(gateway), gateway, { takeDisabled, now: () => 0 })) checks.push(check);
  return checks;
}

const byName = (checks: CoverageCheck[]) => Object.fromEntries(checks.map(c => [c.target ? `${c.name}:${c.target}` : c.name, c]));

describe("coverage checks", () => {
  it("reads every intent once, skips what the units lack and never exercises submit", async () => {
    const base = fixtureGateway();
    const submitted: unknown[] = [];
    const gateway: MoodleGateway = {
      ...base,
      getActivity: async ({ activityId }) => activityId % 10 === 0
        ? { id: activityId, name: "Lecture slides", type: "resource", course_id: Math.floor(activityId / 100), course_name: "", section_name: "", target_name: "slides.pdf", target_url: "", file_entries: [{ name: "slides.pdf", url: "https://moodle.example.edu/pluginfile.php/1/slides.pdf", requires_authentication: true }], url: "" }
        : { ...await base.getActivity({ activityId }), due_pretty: "Saturday, 19 September 2026, 15:55" },
      submitAssignment: async input => { submitted.push(input); return base.submitAssignment!(input); },
    };
    const checks = byName(await collect(gateway));

    expect(Object.keys(checks)).toEqual([
      "units", "home", "due", "unit", "find",
      "item:assign", "item:quiz", "item:resource", "item:url", "item:page", "item:folder", "item:forum",
      "attempt", "grades", "news", "thread", "search_forums", "file", "submit",
    ]);
    expect(checks.units).toMatchObject({ status: "ok", detail: "4 units" });
    expect(checks["item:assign"]).toMatchObject({ status: "ok", detail: expect.stringContaining("submission status"), verified: ["name", "unit", "calendar due date"] });
    expect(checks["item:resource"]).toMatchObject({ status: "ok", detail: "1 file" });
    expect(checks["item:quiz"]).toMatchObject({ status: "skip" });
    expect(checks.attempt).toMatchObject({ status: "skip" });
    expect(checks.grades).toMatchObject({ status: "ok", detail: "2 items, 1 graded" });
    expect(checks.thread).toMatchObject({ status: "ok", detail: "25 posts" });
    expect(checks.file).toMatchObject({ status: "ok", detail: "application/pdf, 6 bytes" });
    expect(checks.submit).toMatchObject({ status: "untested" });
    expect(submitted).toEqual([]);
  });

  it("names the services a check went around and keeps failures to their own line", async () => {
    const base = fixtureGateway();
    let refused: string[] = [];
    const gateway: MoodleGateway = {
      ...base,
      // Stock Moodle refuses the enrolment service to AJAX everywhere; the format state is a site's choice.
      listCourses: async () => { refused.push("core_enrol_get_users_courses"); return base.listCourses(); },
      getCourse: async input => { refused.push("core_courseformat_get_state"); return base.getCourse(input); },
      getGrades: async () => { throw Object.assign(new Error("HTTP 500 loading https://moodle.example.edu/grade/report/user/index.php?id=1"), { code: "upstream" }); },
      getActivity: async input => ({ ...await base.getActivity(input), submission_status: "" }),
    };
    const checks = byName(await collect(gateway, () => { const names = refused; refused = []; return names; }));

    expect(checks.units).toMatchObject({ status: "ok", disabled: ["core_enrol_get_users_courses"] });
    // The dashboard reads every unit's contents first, so that is where the refusal is met.
    expect(checks.home).toMatchObject({ status: "fallback", disabled: expect.arrayContaining(["core_courseformat_get_state"]) });
    expect(checks.grades).toMatchObject({ status: "fail", error_code: "upstream", detail: expect.stringContaining("HTTP 500") });
    // A page read without the field its parser exists for is a theme mismatch, not success.
    expect(checks["item:assign"]).toMatchObject({ status: "empty" });
    expect(checks.news.status).toBe("ok");
  });

  it("stops at an expired session instead of failing every later check", async () => {
    const gateway: MoodleGateway = { ...fixtureGateway(), getOverview: async () => { throw Object.assign(new Error("Session expired"), { code: "auth" }); } };
    await expect(collect(gateway)).rejects.toThrow("Session expired");
  });

  it("skips unit checks when the account has no units", async () => {
    const gateway: MoodleGateway = { ...fixtureGateway(), listCourses: async () => [] };
    const checks = await collect(gateway);
    expect(checks.find(c => c.name === "units")).toMatchObject({ status: "empty" });
    expect(checks.filter(c => c.status === "skip").map(c => c.name)).toEqual(["unit", "find", "item", "attempt", "grades", "news", "thread", "search_forums", "file"]);
  });
});

// Each fault must be caught by the check it belongs to, and only by that check: a coverage
// run is a test suite running on someone else's site, so a false pass or a false alarm
// sends the maintainer after the wrong thing.
describe("coverage catches injected faults", () => {
  // Unit 1 also holds a quiz (id 105) with one reviewed attempt the gradebook agrees with.
  const QUIZ = 105;
  const healthy = (): MoodleGateway => {
    const base = fixtureGateway();
    return {
      ...base,
      getCourse: async input => {
        const detail = await base.getCourse(input);
        if (input.courseId !== 1) return detail;
        const [first, ...rest] = detail.sections;
        return { ...detail, sections: [{ ...first, activities: [...first.activities, { id: QUIZ, name: "Quiz One", modname: "quiz", description: "", url: "", visible: true }] }, ...rest] };
      },
      getActivity: async ({ activityId }) => activityId === QUIZ
        ? { id: QUIZ, name: "Quiz One", type: "quiz", course_id: 1, course_name: "", section_name: "", opens_pretty: "", closes_pretty: "", attempts_allowed: "2", time_limit: "", availability: "", grade: "5.00 out of 10.00 (50%)", attempts: [{ id: 6, number: 1, status: "Finished", started: "", completed: "", duration: "", marks: "1.00/2.00", grade: "5.00 out of 10.00 (50%)", review_url: "" }], url: "" }
        : activityId % 10 === 0
          ? { id: activityId, name: "Lecture slides", type: "resource", course_id: Math.floor(activityId / 100), course_name: "", section_name: "", target_name: "slides.pdf", target_url: "", file_entries: [{ name: "slides.pdf", url: "https://moodle.example.edu/pluginfile.php/1/slides.pdf", requires_authentication: true }], url: "" }
          : { ...await base.getActivity({ activityId }), due_pretty: "Saturday, 19 September 2026, 15:55" },
      getQuizAttempt: async attemptId => ({ ...await base.getQuizAttempt!(attemptId), quiz_id: QUIZ, course_id: 1, grade: "5.00 out of 10.00 (50%)" }),
      getGrades: async input => {
        const grades = await base.getGrades(input);
        return { ...grades, items: [...grades.items, { name: "Quiz One", item_type: "quiz", grade: "5.00", range: "0–10", percentage: "50.00 %", weight: "", contribution: "", feedback: "", url: "", status: "" }] };
      },
    };
  };
  const run = async (gateway: MoodleGateway, options: { timeoutMs?: number } = {}) => {
    const checks: CoverageCheck[] = [];
    for await (const check of checkCoverage(createIntentService(gateway), gateway, { now: () => 0, retryDelayMs: 0, ...options })) checks.push(check);
    return byName(checks);
  };
  const failing = (checks: Record<string, CoverageCheck>) => Object.entries(checks).filter(([, c]) => !["ok", "fallback", "skip", "untested"].includes(c.status)).map(([key]) => key);

  it("raises no alarm on a consistent site", async () => {
    const checks = await run(healthy());
    expect(failing(checks)).toEqual([]);
    expect(checks.search_forums).toMatchObject({ status: "ok", verified: ["forum listing"] });
    expect(checks.thread).toMatchObject({ status: "ok", ref: 60, verified: ["forum listing"] });
    expect(checks.attempt).toMatchObject({ status: "ok", verified: ["quiz", "quiz page grade"] });
    expect(checks.grades).toMatchObject({ status: "ok", ref: 1, verified: ["quiz page grade"] });
    expect(checks["item:assign"].verified).toContain("unit");
  });

  it.each<[string, (base: MoodleGateway) => Partial<MoodleGateway>, string, string]>([
    ["a page that names another activity", () => ({ getActivity: async input => ({ ...await healthy().getActivity(input), ...(input.activityId % 10 === 1 ? { name: "Unit handbook" } : {}) }) }), "item:assign", "mismatch"],
    ["a due date the page reader cannot read", base => ({ getActivity: async input => input.activityId % 10 === 0 ? healthy().getActivity(input) : { ...await base.getActivity(input), due_pretty: "" } }), "item:assign", "mismatch"],
    ["a due date that disagrees with the calendar", () => ({ getActivity: async input => ({ ...await healthy().getActivity(input), due_pretty: "Saturday, 19 September 2099, 15:55" }) }), "item:assign", "mismatch"],
    ["a due time that disagrees with the calendar", () => ({ getActivity: async input => ({ ...await healthy().getActivity(input), due_pretty: "Saturday, 19 September 2026, 16:55" }) }), "item:assign", "mismatch"],
    ["a resource page with the wrong file", () => ({ getActivity: async input => ({ ...await healthy().getActivity(input), ...(input.activityId % 10 === 0 ? { file_entries: [{ name: "handout.docx", url: "", requires_authentication: true }] } : {}) }) }), "item:resource", "mismatch"],
    ["a search that misses a known discussion", () => ({ searchForums: async () => [] }), "search_forums", "mismatch"],
    ["a dashboard that drops a unit", base => ({ getOverview: async input => ({ ...await base.getOverview(input), courses: units.slice(1) }) }), "home", "mismatch"],
    ["posts without text", base => ({ getThread: async input => { const thread = await base.getThread(input); return { ...thread, posts: thread.posts.map(post => ({ ...post, message_text: "" })) }; } }), "thread", "empty"],
    ["a course format read as empty sections", () => ({ getCourse: async ({ courseId }) => ({ course: units.find(c => c.id === courseId)!, sections: sections("Week", courseId).map(section => ({ ...section, activities: [] })) }) }), "unit", "empty"],
    ["a page that places the activity in another unit", base => ({ getActivity: async input => ({ ...await healthy().getActivity(input), ...(input.activityId === 101 ? { course_id: 93 } : {}) }) }), "item:assign", "mismatch"],
    ["a discussion whose subject differs from the listing", base => ({ getThread: async input => ({ ...await base.getThread(input), subject: "Exam timetable" }) }), "thread", "mismatch"],
    ["a review page for another quiz", () => ({ getQuizAttempt: async attemptId => ({ ...await healthy().getQuizAttempt!(attemptId), quiz_id: 999 }) }), "attempt", "mismatch"],
    ["a review page with another grade", () => ({ getQuizAttempt: async attemptId => ({ ...await healthy().getQuizAttempt!(attemptId), grade: "9.00 out of 10.00 (90%)" }) }), "attempt", "mismatch"],
    ["a gradebook that disagrees with the quiz page", () => ({ getGrades: async input => { const grades = await healthy().getGrades(input); return { ...grades, items: grades.items.map(item => item.name === "Quiz One" ? { ...item, grade: "7.00", percentage: "70.00 %" } : item) }; } }), "grades", "mismatch"],
    ["a gradebook that leaves out a graded quiz", () => ({ getGrades: async input => { const grades = await healthy().getGrades(input); return { ...grades, items: grades.items.filter(item => !item.name.startsWith("Quiz")) }; } }), "grades", "mismatch"],
    ["quiz attempts listed without their state", () => ({ getActivity: async input => { const item = await healthy().getActivity(input); return input.activityId === QUIZ ? { ...item, attempts: (item as unknown as { attempts: Array<Record<string, unknown>> }).attempts.map(a => ({ ...a, status: "" })) } as typeof item : item; } }), "item:quiz", "empty"],
    ["a review summary without the attempt's state", () => ({ getQuizAttempt: async attemptId => ({ ...await healthy().getQuizAttempt!(attemptId), status: "" }) }), "attempt", "empty"],
    ["a review summary whose marks were not read", () => ({ getQuizAttempt: async attemptId => ({ ...await healthy().getQuizAttempt!(attemptId), marks: "", grade: "" }) }), "attempt", "empty"],
    ["a quiz page whose attempt list lost the marks", () => ({ getActivity: async input => { const item = await healthy().getActivity(input); return input.activityId === QUIZ ? { ...item, attempts: (item as unknown as { attempts: Array<Record<string, unknown>> }).attempts.map(a => ({ ...a, marks: "", grade: "" })) } as typeof item : item; } }), "attempt", "empty"],
    ["a gradebook that fails outright", () => ({ getGrades: async () => { throw Object.assign(new Error("HTTP 500 loading https://moodle.example.edu/grade/report/user/index.php"), { code: "upstream" }); } }), "grades", "fail"],
  ])("flags %s", async (_label, fault, key, status) => {
    const base = healthy();
    const checks = await run({ ...base, ...fault(base) });
    expect(checks[key]).toMatchObject({ status });
    // The fault stays on its own line; every other check keeps passing.
    expect(failing(checks)).toEqual([key]);
  });

  it("checks a localized due date and reports unknown formats as partial", async () => {
    const base = healthy();
    for (const [date, status] of [["Samstag, 19. September 2026, 15:55", "ok"], ["Samstag, 19. September 2099, 15:55", "mismatch"], ["when the teacher says", "partial"]]) {
      const checks = await run({ ...base, getUser: async () => ({ ...siteUser, lang: "de" }), getActivity: async input => ({ ...await base.getActivity(input), due_pretty: date }) });
      expect(checks["item:assign"].status).toBe(status);
      if (status === "partial") expect(checks["item:assign"].verified).toBeUndefined();
    }
  });

  it("does not compare the host clock when Moodle's timezone is unresolved", async () => {
    const gateway = healthy();
    const checks: CoverageCheck[] = [];
    for await (const check of checkCoverage(createIntentService(gateway), gateway, { now: () => 0, timezone: null })) checks.push(check);
    expect(byName(checks)["item:assign"]).toMatchObject({ status: "partial", detail: expect.stringContaining("timezone") });
  });

  it("requests and follows detailed gradebook pages for cross-checking", async () => {
    const base = healthy();
    const gateway: MoodleGateway = { ...base, getGrades: async input => {
      const grades = await base.getGrades(input);
      return { ...grades, items: [...Array.from({ length: 201 }, (_, i) => ({ ...grades.items[0], name: `Ungraded ${i}`, grade: "-" })), ...grades.items] };
    } };
    const service = createIntentService(gateway);
    const originalRun = service.run;
    const calls: Array<Record<string, unknown>> = [];
    const paged = intentContracts.grades.input.safeParse({ mode: "all", limit: 200 }).success;
    service.run = async (name, args = {}) => {
      if (name === "grades") calls.push(args);
      return originalRun(name, args);
    };
    const checks: CoverageCheck[] = [];
    for await (const check of checkCoverage(service, gateway, { now: () => 0 })) checks.push(check);
    expect(byName(checks).grades).toMatchObject({ status: "ok", verified: ["quiz page grade"] });
    expect(calls.map(call => call.offset ?? 0)).toEqual(paged ? [0, 200] : [0]);
  });

  it("accepts a gradebook that shows the same grade as a percentage or a letter", async () => {
    for (const shown of [{ grade: "50.00 %", percentage: "" }, { grade: "C", percentage: "" }]) {
      const base = healthy();
      const checks = await run({ ...base, getGrades: async input => { const grades = await base.getGrades(input); return { ...grades, items: grades.items.map(item => item.name === "Quiz One" ? { ...item, ...shown } : item) }; } });
      expect(checks.grades.status).toBe("ok");
    }
  });

  it("looks past an empty forum and a unit without announcements for a discussion to open", async () => {
    const base = healthy();
    const checks = await run({
      ...base,
      getCourse: async input => {
        const detail = await base.getCourse(input);
        const [first, ...rest] = detail.sections;
        return { ...detail, sections: [{ ...first, activities: [...first.activities, { id: 70 + input.courseId, name: "Q&A", modname: "forum", description: "", url: "", visible: true }] }, ...rest] };
      },
      getActivity: async input => input.activityId > 70 && input.activityId < 80 ? { id: input.activityId, name: "Q&A", modname: "forum", type: "forum", description: "", url: "", visible: true } : base.getActivity(input),
      listNewsForums: async courseId => courseId === 1 ? [] : base.listNewsForums!(courseId),
      listThreads: async forumId => forumId === 71 ? [] : base.listThreads!(forumId),
    });
    expect(checks["item:forum"]).toMatchObject({ status: "ok", ref: 72, detail: "1 thread" });
    expect(checks.news).toMatchObject({ status: "ok", ref: 2 });
    expect(checks.thread).toMatchObject({ status: "ok", ref: 60 });
  });

  it("retries a transient failure once before deciding", async () => {
    const base = healthy();
    let calls = 0;
    const flaky = await run({ ...base, getGrades: async input => { calls += 1; if (calls === 1) throw new Error("HTTP 503 loading https://moodle.example.edu/grade/report/user/index.php"); return base.getGrades(input); } });
    expect(flaky.grades).toMatchObject({ status: "ok", retried: true });
    const down = await run({ ...base, getGrades: async () => { throw new Error("HTTP 503 loading https://moodle.example.edu/grade/report/user/index.php"); } });
    expect(down.grades).toMatchObject({ status: "fail", retried: true });
    // A real error is not retried: it would only double the time to the same answer.
    calls = 0;
    await run({ ...base, getGrades: async () => { calls += 1; throw new Error("Gradebook is disabled."); } });
    expect(calls).toBe(1);
  });

  it("fails a check that hangs instead of stalling the report", async () => {
    const checks = await run({ ...healthy(), getGrades: () => new Promise(() => undefined) }, { timeoutMs: 20 });
    expect(checks.grades).toMatchObject({ status: "fail", error_code: "timeout" });
    expect(checks.news.status).toBe("ok");
  });

  it("samples only activities the account can open", async () => {
    const base = healthy();
    const opened: number[] = [];
    const checks = await run({
      ...base,
      getCourse: async input => {
        const detail = await base.getCourse(input);
        const [first, ...rest] = detail.sections;
        return { ...detail, sections: [{ ...first, activities: [{ id: 999, name: "Hidden notes", modname: "page", description: "", url: "", visible: false }, ...first.activities] }, ...rest] };
      },
      getActivity: async input => { opened.push(input.activityId); return base.getActivity(input); },
    });
    expect(opened).not.toContain(999);
    expect(checks["item:page"]).toMatchObject({ status: "skip" });
  });
});

describe("client service refusals", () => {
  it("reports refusals from the site and from what it already knows, and can relearn them", async () => {
    const sent: string[] = [];
    const client = createMoodleClientCore("https://moodle.example.edu", {
      cookie: { name: "MoodleSession", value: "cookie" },
      sesskey: "key",
      userid: 7,
      fetchImpl: async (_input, init) => {
        const batch = JSON.parse(String(init?.body)) as { methodname: string }[];
        sent.push(...batch.map(c => c.methodname));
        return Response.json(batch.map(() => ({ error: true, exception: { errorcode: "servicenotavailable", message: "disabled" } })));
      },
    });
    const heard: string[] = [];
    const stop = client.onServiceUnavailable(name => heard.push(name));

    await client.callBatch([{ methodname: "core_enrol_get_users_courses" }]);
    await client.callBatch([{ methodname: "core_enrol_get_users_courses" }]);
    expect(sent).toEqual(["core_enrol_get_users_courses"]);
    expect(heard).toEqual(["core_enrol_get_users_courses", "core_enrol_get_users_courses"]);

    await client.forgetUnavailableServices();
    await client.callBatch([{ methodname: "core_enrol_get_users_courses" }]);
    expect(sent).toHaveLength(2);
    stop();
    await client.callBatch([{ methodname: "core_enrol_get_users_courses" }]);
    expect(heard).toHaveLength(3);
  });
});

describe("moodle coverage", () => {
  function site(latest: string | null = VERSION): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "registry.npmjs.org") return latest ? Response.json({ latest }) : new Response("", { status: 503 });
      const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/my/") return html('<html><script>M.cfg = {"sesskey":"fixture","userId":7,"theme":"boost"};</script><span class="userfullname">Alex</span></html>');
      if (url.pathname === "/lib/ajax/service-nologin.php") return Response.json([{ error: false, data: { enablewebservices: 1, enablemobilewebservice: 0 } }]);
      if (url.pathname.includes("/pluginfile.php/")) return new Response("slides", { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="slides.pdf"' } });
      if (url.pathname === "/mod/resource/view.php") return html('<html><h1>Slides</h1><div class="resourceworkaround"><a href="/pluginfile.php/1/slides.pdf">slides.pdf</a></div></html>');
      // The fixture page sits in course 101; here it belongs to the unit it was sampled from.
      if (url.pathname === "/mod/assign/view.php") return html(fixture("assign.html").replaceAll("course/view.php?id=101", `course/view.php?id=${units[0].id}`));
      if (url.pathname === "/course/view.php") return html(fixture("course-page.html"));
      if (url.pathname.startsWith("/grade/")) return html(fixture("grades.html"));
      if (url.pathname === "/lib/ajax/service.php") {
        const batch = JSON.parse(String(init?.body)) as { methodname: string; args: Record<string, number> }[];
        return Response.json(batch.map(c => {
          switch (c.methodname) {
            // Stock Moodle refuses the first to AJAX callers; the second is a site switching notifications off.
            case "core_enrol_get_users_courses": case "message_popup_get_popup_notifications": return { error: true, exception: { errorcode: "servicenotavailable", message: "Service disabled" } };
            case "core_course_get_enrolled_courses_by_timeline_classification": return { error: false, data: { courses: units, nextoffset: 4 } };
            case "core_webservice_get_site_info": return { error: false, data: { ...siteUser, release: "4.5.1 (Build: 20250101)" } };
            // Named as the assignment fixture page is, so the page and the contents agree.
            case "core_course_get_contents": return { error: false, data: sections("Week", c.args.courseid).map(s => ({ ...s, modules: s.activities.map(a => a.modname === "assign" ? { ...a, name: "Essay 1" } : a) })) };
            case "core_calendar_get_action_events_by_timesort": case "core_calendar_get_action_events_by_course": return { error: false, data: { events: [] } };
            case "core_course_get_course_module": return { error: false, data: { cm: { id: c.args.cmid, course: 2, modname: c.args.cmid % 10 === 0 ? "resource" : "assign" } } };
            default: return { error: false, data: c.methodname.startsWith("mod_forum") ? [] : {} };
          }
        }));
      }
      throw new Error(`Unexpected fixture path ${url.pathname}`);
    };
  }
  async function command(args: string[], latest?: string | null, fetchImpl = site(latest)) {
    const home = await mkdtemp(join(tmpdir(), "moodle-coverage-"));
    let stdout = "", stderr = "";
    try {
      const code = await runCli(["node", "moodle", "coverage", ...args, "--no-cache"], {
        env: { MOODLE_BASE_URL: siteUser.siteurl, MOODLE_SESSION: "fixture" }, homeDir: home, cwd: home, fetchImpl,
        stdin: { isTTY: false } as NodeJS.ReadStream,
        stdout: { isTTY: false, write: (value: string) => { stdout += value; return true; } } as NodeJS.WriteStream,
        stderr: { write: (value: string) => { stderr += value; return true; } },
      });
      return { code, stdout, stderr };
    } finally { await rm(home, { recursive: true, force: true }); }
  }

  it("reports the site and each check as JSON without the session or personal names", async () => {
    const result = await command(["--json"]);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.cli).toEqual({ version: VERSION, latest: VERSION, runtime: expect.stringMatching(/^(node|bun) \d/u) });
    expect(report.site).toEqual({ url: siteUser.siteurl, release: "4.5.1 (Build: 20250101)", theme: "boost", mobile_service: false });
    expect(report.disabled_services).toEqual(["core_enrol_get_users_courses", "message_popup_get_popup_notifications"]);
    expect(report.checks[0]).toMatchObject({ name: "units", status: "ok", disabled: ["core_enrol_get_users_courses"] });
    expect(report.checks[1]).toMatchObject({ name: "home", status: "partial", disabled: expect.arrayContaining(["message_popup_get_popup_notifications"]) });
    expect(report.checks.find((c: CoverageCheck) => c.name === "file")).toMatchObject({ status: "ok" });
    expect(report.summary.ok).toBeGreaterThan(5);
    for (const secret of ["fixture", "Alex", "Databases", "Algorithms"]) expect(result.stdout).not.toContain(secret);
  });

  it("prints one line per check for a person", async () => {
    const result = await command(["--table"]);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^moodle-cli ${VERSION.replace(/\./gu, "\\.")} · latest · (node|bun) `, "u"));
    expect(lines[1]).toBe(`Checking ${siteUser.siteurl}`);
    expect(lines[2]).toBe("Moodle 4.5.1 (Build: 20250101) · theme boost · mobile app service off");
    expect(lines).toContain("  ✓ units           4 units");
    expect(lines).toContain("  ! home            notifications: Service disabled · went around message_popup_get_popup_notifications");
    expect(lines).toContain("  · submit          Not exercised: it writes to Moodle. moodle submit REF FILE plans without uploading.");
    expect(result.stdout).toContain("8 skipped · 1 untested");
    // Only what this site switched off; stock Moodle's own refusals are the normal path.
    expect(result.stdout).toContain("Disabled on this site: message_popup_get_popup_notifications.");
  });

  it("exits 3 when a page was read but not understood", async () => {
    // The command sets process.exitCode, as doctor does, rather than failing the run.
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    await command(["--json"]);
    expect(process.exitCode).toBeUndefined();
    const healthy = site();
    // A page with the activity's name and nothing else; every other check agrees.
    const unreadable: typeof fetch = async (input, init) => new URL(String(input)).pathname === "/mod/assign/view.php"
      ? new Response("<html><h1>Essay 1</h1></html>", { headers: { "content-type": "text/html" } })
      : healthy(input, init);
    const result = await command(["--json"], VERSION, unreadable);
    const statuses = JSON.parse(result.stdout).checks.map((c: CoverageCheck) => c.status);
    expect(statuses).toContain("empty");
    expect(statuses).not.toContain("mismatch");
    expect(statuses).not.toContain("fail");
    expect(process.exitCode).toBe(3);
    process.exitCode = exitCode;
  });

  it("warns that an outdated or unverified build may report failures already fixed", async () => {
    expect((await command(["--table"], "99.0.0")).stdout.split("\n")[0]).toContain("99.0.0 is out; run moodle update before reporting a failure");
    const offline = await command(["--json"], null);
    expect(JSON.parse(offline.stdout).cli.latest).toBeNull();
    expect((await command(["--table"], null)).stdout.split("\n")[0]).toContain("latest release unknown");
  });
});
