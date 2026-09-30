import { expect, it } from "vitest";
import { createMoodleClientCore } from "../src/moodle-client-core.js";
it("uses Moodle's 50-event page cap and the last event cursor for exact totals", async () => {
  const seen: Array<{ limitnum: number; aftereventid: number }> = [];
  const client = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 1,
    fetchImpl: async (_input, init) => {
      const calls = JSON.parse(String(init?.body));
      const args = calls[0].args;
      expect(args.limitnum).toBeLessThanOrEqual(50);
      seen.push(args);
      return Response.json([{ error: false, data: { events: Array.from({ length: Math.min(args.limitnum, 73 - args.aftereventid) }, (_, i) => ({ id: args.aftereventid + i + 1, name: "Task", timesort: 1800000000, course: { id: 1 } })) } }]);
    },
  });
  expect(await client.getTodo(Number.MAX_SAFE_INTEGER, 30)).toHaveLength(73);
  expect(seen).toMatchObject([{ limitnum: 50, aftereventid: 0 }, { limitnum: 50, aftereventid: 50 }]);
});

it("keeps redirected CDN resources addressable through the authenticated Moodle URL", async () => {
  const client = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 1,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/mod/resource/view.php")) return new Response(null, { status: 302, headers: { location: "https://files.example.net/signed/file" } });
      expect(url).toBe("https://files.example.net/signed/file");
      return new Response("pdf", { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="slides.pdf"' } });
    },
  });
  const resource = await client.getResource(22);
  expect(resource).toMatchObject({ name: "slides.pdf", file_entries: [{ name: "slides.pdf", url: "https://moodle.example.edu/mod/resource/view.php?id=22" }] });
  expect(JSON.stringify(resource)).not.toContain("files.example.net");
});

const REFUSED = { error: true, exception: { message: "Web service is not available", errorcode: "servicenotavailable" } };

// A site with the timeline service disabled. Like Moodle, a batch stops at its first
// failing function, and each unit's calendar pages by the last event id.
function timelineDisabledSite(eventsByUnit: Record<number, Array<{ id: number; timesort: number }>>, options: { perCourseDisabled?: boolean } = {}) {
  const calls: Array<{ methodname: string; args: Record<string, unknown> }> = [];
  const now = Math.floor(Date.now() / 1000);
  const client = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 1,
    userInfo: { userid: 1, username: "", fullname: "Student", sitename: "Example", siteurl: "https://moodle.example.edu", lang: "" },
    fetchImpl: async (_input, init) => {
      const envelope: unknown[] = [];
      for (const { index, methodname, args } of JSON.parse(String(init?.body))) {
        calls.push({ methodname, args });
        if (methodname === "core_calendar_get_action_events_by_timesort" || (options.perCourseDisabled && methodname === "core_calendar_get_action_events_by_course")) {
          envelope.push({ index, ...REFUSED });
          break;
        }
        if (methodname === "core_enrol_get_users_courses") {
          envelope.push({ index, error: false, data: Object.keys(eventsByUnit).map((id) => ({ id: Number(id), fullname: `Unit ${id}`, shortname: `U${id}` })) });
        } else if (methodname === "core_calendar_get_action_events_by_course") {
          const unit = eventsByUnit[args.courseid] ?? [];
          const start = args.aftereventid ? unit.findIndex((event) => event.id === args.aftereventid) + 1 : 0;
          const events = unit.slice(start, start + args.limitnum).map((event) => ({ ...event, timesort: now + event.timesort, name: `Task ${event.id}`, course: { id: args.courseid } }));
          envelope.push({ index, error: false, data: { events } });
        } else {
          envelope.push({ index, error: false, data: {} });
        }
      }
      return Response.json(envelope);
    },
  });
  return { client, calls };
}

it("merges each unit's calendar when the site disables the timeline service", async () => {
  const { client, calls } = timelineDisabledSite({
    11: [{ id: 102, timesort: 100 }, { id: 101, timesort: 300 }, { id: 103, timesort: 500 }],
    12: [{ id: 201, timesort: 200 }, { id: 101, timesort: 300 }, { id: 202, timesort: 400 }],
  });
  const todo = await client.getTodo(4, 30);
  expect(todo.map((item) => item.id)).toEqual([102, 201, 101, 202]);
  const perCourse = calls.filter((call) => call.methodname === "core_calendar_get_action_events_by_course");
  expect(perCourse.map((call) => call.args.courseid).sort()).toEqual([11, 12]);
  expect(perCourse.every((call) => typeof call.args.timesortto === "number" && call.args.timesortto > 0)).toBe(true);

  // A unit with more than one 50-event page is read to the end; equal times order by id.
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 1000 + i, timesort: 1000 + i }));
  const large = timelineDisabledSite({ 11: many, 12: [{ id: 5, timesort: 1030 }] });
  const all = await large.client.getTodo(Number.MAX_SAFE_INTEGER);
  expect(all).toHaveLength(61);
  expect(all.map((item) => item.due_at)).toEqual([...all.map((item) => item.due_at)].sort((a, b) => a - b));
  expect(all.findIndex((item) => item.id === 5)).toBe(30);
  expect(large.calls.filter((call) => call.args.courseid === 11).map((call) => call.args.aftereventid)).toEqual([0, 1049]);
});

it("serves the dashboard deadlines from each unit's calendar", async () => {
  const { client } = timelineDisabledSite({ 11: [{ id: 102, timesort: 100 }], 12: [{ id: 201, timesort: 50 }] });
  const overview = await client.getOverview(5, 30, 5);
  expect(overview.errors).toEqual([]);
  expect(overview.todo.map((item) => item.id)).toEqual([201, 102]);
});

it("reports the refusal instead of looping when both calendar services are disabled", async () => {
  const { client, calls } = timelineDisabledSite({ 11: [], 12: [] }, { perCourseDisabled: true });
  await expect(client.getTodo(20, 30)).rejects.toMatchObject({ moodleErrorCode: "servicenotavailable" });
  await expect(client.getTodo(20, 30, 11)).rejects.toMatchObject({ moodleErrorCode: "servicenotavailable" });
  // The timeline once, each unit once; both refusals are learned, so the second read stays local.
  expect(calls.filter((call) => call.methodname.startsWith("core_calendar_"))).toHaveLength(3);
});
