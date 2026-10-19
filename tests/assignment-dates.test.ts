import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MoodleClient } from "../src/client.js";

const baseUrl = "https://moodle.example.edu";
const month = JSON.parse(readFileSync(new URL("./fixtures/moodle-5.0/calendar-past-assignment.json", import.meta.url), "utf8"));
const timestamp = 1791708643;
const view = (date: string) => `<html><body id="page-mod-assign-view"><h1>Essay Zero</h1><div class="activity-dates"><div><strong>Due:</strong> ${date}</div></div></body></html>`;
function assignmentClient(shown: string, lang = "en", errorcode?: string) {
  const calls: Array<{ methodname: string; args: Record<string, unknown> }> = [];
  const client = new MoodleClient(baseUrl, {
    cookie: { name: "MoodleSession", value: "test" }, sesskey: "test", userid: 3,
    userInfo: { userid: 3, username: "student", fullname: "Student", sitename: "Moodle", siteurl: baseUrl, lang },
    fetchImpl: async (_url, init) => {
      if (init?.method !== "POST") return new Response(view(shown));
      const batch = JSON.parse(String(init.body)) as typeof calls;
      calls.push(...batch);
      return Response.json(batch.map((call, index) => call.methodname === "core_calendar_get_calendar_monthly_view"
        ? errorcode ? { index, error: true, exception: { errorcode, message: "Calendar unavailable" } } : { index, error: false, data: month }
        : { index, error: false, data: [] }));
    },
  });
  return { client, calls };
}

describe("assignment canonical dates through MoodleClient", () => {
  it.each(["Sunday, 11 October 2026, 8:50 AM", "Sunday, October 11, 2026, 8:50 AM"])("reads a past deadline from one calendar month for %s", async shown => {
    const { client, calls } = assignmentClient(shown);
    expect(await client.getAssignment(79)).toMatchObject({ due_at: new Date(timestamp * 1000).toISOString() });
    expect(calls.filter(c => c.methodname === "core_calendar_get_calendar_monthly_view")).toEqual([expect.objectContaining({ methodname: "core_calendar_get_calendar_monthly_view", args: expect.objectContaining({ year: 2026, month: 10 }) })]);
  });
  it("finds a translated month and keeps the site's canonical timestamp", async () => {
    const { client } = assignmentClient("Sonntag, 11. Oktober 2026, 08:50", "de");
    expect(await client.getAssignment(79)).toMatchObject({ due_at: "2026-10-11T08:50:43.000Z" });
  });
  it.each(["zh_cn", "ja"])("reads a CJK deadline with month suffixes for %s", async lang => {
    const { client } = assignmentClient("2026年10月11日 08:50", lang);
    expect(await client.getAssignment(79)).toMatchObject({ due_at: "2026-10-11T08:50:43.000Z" });
  });
  it("omits uncertain dates and degrades gracefully when the calendar service is disabled", async () => {
    const unknown = assignmentClient("11/10/2026 08:50", "en");
    expect(await unknown.client.getAssignment(79)).not.toHaveProperty("due_at");
    expect(unknown.calls.some(c => c.methodname === "core_calendar_get_calendar_monthly_view")).toBe(false);
    const unsupported = assignmentClient("11 October 2026", "not_a_moodle_locale");
    expect(await unsupported.client.getAssignment(79)).not.toHaveProperty("due_at");
    expect(unsupported.calls.some(c => c.methodname === "core_calendar_get_calendar_monthly_view")).toBe(false);
    const disabled = assignmentClient("11 October 2026", "en", "servicenotavailable");
    expect(await disabled.client.getAssignment(79)).not.toHaveProperty("due_at");
  });
});
