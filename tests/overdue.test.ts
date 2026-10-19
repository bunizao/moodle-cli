import { expect, it, vi } from "vitest";
import { createMoodleClientCore } from "../src/moodle-client-core.js";

it("keeps overdue work that Moodle still lets the student submit", async () => {
  const now = 1_800_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  try {
    const client = createMoodleClientCore("https://moodle.example.edu", {
      cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 1,
      fetchImpl: async (_input, init) => {
        const [{ args }] = JSON.parse(String(init?.body));
        const events = [
          { id: 1, name: "Overdue quiz prep", timesort: now - 86400, overdue: true, action: { actionable: true }, course: { id: 2 } },
          { id: 2, name: "Closed work", timesort: now - 86400, overdue: true, action: { actionable: false }, course: { id: 2 } },
          { id: 3, name: "Next essay", timesort: now + 86400, overdue: false, action: { actionable: true }, course: { id: 2 } },
        ].filter(event => event.timesort >= args.timesortfrom);
        return Response.json([{ error: false, data: { events } }]);
      },
    });
    expect(await client.getTodo(20, 14)).toMatchObject([
      { id: 1, overdue: true, actionable: true, due_at: now - 86400 },
      { id: 3, overdue: false },
    ]);
  } finally { clock.mockRestore(); }
});

it.each([5, 75])("refills a dashboard limit of %i after closed overdue rows", async limit => {
  const now = Math.floor(Date.now() / 1000);
  const events = Array.from({ length: 81 }, (_, index) => ({ id: index + 1, name: `Task ${index + 1}`, timesort: now + index, overdue: index === 0, action: { actionable: index !== 0 }, course: { id: 2 } }));
  const client = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 1,
    userInfo: { userid: 1, username: "student", fullname: "Student", sitename: "Moodle", siteurl: "https://moodle.example.edu" },
    fetchImpl: async (_url, init) => Response.json(JSON.parse(String(init?.body)).map(({ index, methodname, args }: { index: number; methodname: string; args: { aftereventid: number; limitnum: number } }) => ({
      index, error: false, data: methodname === "core_calendar_get_action_events_by_timesort"
        ? { events: events.filter(event => event.id > args.aftereventid).slice(0, args.limitnum) }
        : methodname === "core_enrol_get_users_courses" ? [] : {},
    }))),
  });
  const snapshot = await client.getOverview(limit, 30);
  expect(snapshot.errors).toEqual([]);
  expect(snapshot.todo).toHaveLength(limit);
  expect(snapshot.todo[0].id).toBe(2);
  expect(snapshot.todo.at(-1)?.id).toBe(limit + 1);
});
