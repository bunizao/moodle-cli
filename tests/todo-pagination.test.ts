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
