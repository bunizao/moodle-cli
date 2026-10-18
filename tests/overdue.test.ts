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
