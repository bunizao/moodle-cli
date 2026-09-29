import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { checkCoverage, type CoverageCheck } from "../src/coverage.js";
import { createIntentService } from "../src/intents.js";
import type { MoodleGateway } from "../src/mcp/gateway.js";
import { createMoodleClientCore } from "../src/moodle-client-core.js";
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
        ? { id: activityId, name: "Lecture slides", type: "resource", course_id: 2, course_name: "", section_name: "", target_name: "slides.pdf", target_url: "", file_entries: [{ name: "slides.pdf", url: "https://moodle.example.edu/pluginfile.php/1/slides.pdf", requires_authentication: true }], url: "" }
        : base.getActivity({ activityId }),
      submitAssignment: async input => { submitted.push(input); return base.submitAssignment!(input); },
    };
    const checks = byName(await collect(gateway));

    expect(Object.keys(checks)).toEqual([
      "units", "home", "due", "unit", "find",
      "item:assign", "item:quiz", "item:resource", "item:url", "item:page", "item:folder", "item:forum",
      "attempt", "grades", "news", "thread", "search_forums", "file", "submit",
    ]);
    expect(checks.units).toMatchObject({ status: "ok", detail: "4 units" });
    expect(checks["item:assign"]).toMatchObject({ status: "ok", detail: expect.stringContaining("submission status") });
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
      listCourses: async () => { refused.push("core_enrol_get_users_courses"); return base.listCourses(); },
      getGrades: async () => { throw Object.assign(new Error("HTTP 500 loading https://moodle.example.edu/grade/report/user/index.php?id=1"), { code: "upstream" }); },
      getActivity: async input => ({ ...await base.getActivity(input), submission_status: "" }),
    };
    const checks = byName(await collect(gateway, () => { const names = refused; refused = []; return names; }));

    expect(checks.units).toMatchObject({ status: "fallback", disabled: ["core_enrol_get_users_courses"] });
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
  function site(): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input));
      const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/my/") return html('<html><script>M.cfg = {"sesskey":"fixture","userId":7,"theme":"boost"};</script><span class="userfullname">Alex</span></html>');
      if (url.pathname === "/lib/ajax/service-nologin.php") return Response.json([{ error: false, data: { enablewebservices: 1, enablemobilewebservice: 0 } }]);
      if (url.pathname.includes("/pluginfile.php/")) return new Response("slides", { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="slides.pdf"' } });
      if (url.pathname === "/mod/resource/view.php") return html('<html><h1>Slides</h1><div class="resourceworkaround"><a href="/pluginfile.php/1/slides.pdf">slides.pdf</a></div></html>');
      if (url.pathname === "/mod/assign/view.php") return html(fixture("assign.html"));
      if (url.pathname === "/course/view.php") return html(fixture("course-page.html"));
      if (url.pathname.startsWith("/grade/")) return html(fixture("grades.html"));
      if (url.pathname === "/lib/ajax/service.php") {
        const batch = JSON.parse(String(init?.body)) as { methodname: string; args: Record<string, number> }[];
        return Response.json(batch.map(c => {
          switch (c.methodname) {
            case "core_enrol_get_users_courses": return { error: true, exception: { errorcode: "servicenotavailable", message: "Service disabled" } };
            case "core_course_get_enrolled_courses_by_timeline_classification": return { error: false, data: { courses: units, nextoffset: 4 } };
            case "core_webservice_get_site_info": return { error: false, data: { ...siteUser, release: "4.5.1 (Build: 20250101)" } };
            case "core_course_get_contents": return { error: false, data: sections("Week", c.args.courseid).map(s => ({ ...s, modules: s.activities })) };
            case "core_calendar_get_action_events_by_timesort": case "core_calendar_get_action_events_by_course": return { error: false, data: { events: [] } };
            case "core_course_get_course_module": return { error: false, data: { cm: { id: c.args.cmid, course: 2, modname: c.args.cmid % 10 === 0 ? "resource" : "assign" } } };
            default: return { error: false, data: c.methodname.startsWith("mod_forum") ? [] : {} };
          }
        }));
      }
      throw new Error(`Unexpected fixture path ${url.pathname}`);
    };
  }
  async function command(args: string[]) {
    const home = await mkdtemp(join(tmpdir(), "moodle-coverage-"));
    let stdout = "", stderr = "";
    try {
      const code = await runCli(["node", "moodle", "coverage", ...args, "--no-cache"], {
        env: { MOODLE_BASE_URL: siteUser.siteurl, MOODLE_SESSION: "fixture" }, homeDir: home, cwd: home, fetchImpl: site(),
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
    expect(report.site).toEqual({ url: siteUser.siteurl, release: "4.5.1 (Build: 20250101)", theme: "boost", mobile_service: false });
    expect(report.disabled_services).toEqual(["core_enrol_get_users_courses"]);
    expect(report.checks[0]).toMatchObject({ name: "units", status: "fallback", disabled: ["core_enrol_get_users_courses"] });
    expect(report.checks.find((c: CoverageCheck) => c.name === "file")).toMatchObject({ status: "ok" });
    expect(report.summary.ok).toBeGreaterThan(5);
    for (const secret of ["fixture", "Alex", "Databases", "Algorithms"]) expect(result.stdout).not.toContain(secret);
  });

  it("prints one line per check for a person", async () => {
    const result = await command(["--table"]);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe(`Checking ${siteUser.siteurl}`);
    expect(lines[1]).toBe("Moodle 4.5.1 (Build: 20250101) · theme boost · mobile app service off");
    expect(lines).toContain("  ↷ units           4 units · went around core_enrol_get_users_courses");
    expect(lines).toContain("  · submit          Not exercised: it writes to Moodle. moodle submit REF FILE plans without uploading.");
    expect(result.stdout).toContain("7 skipped · 1 untested");
    expect(result.stdout).toContain("Disabled on this site: core_enrol_get_users_courses.");
  });
});
