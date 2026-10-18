import { expect, it } from "vitest";
import { createMoodleClientCore } from "../src/moodle-client-core.js";

it("returns a restricted activity with its reason without opening its content", async () => {
  const client = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 1,
    fetchImpl: async (url) => {
      expect(String(url)).toContain("/lib/ajax/service.php");
      return Response.json([{ error: false, data: { cm: { id: 5, name: "Next week", modname: "page", course: 2, uservisible: false, availabilityinfo: "<p>Opens next week</p>" } } }]);
    },
  });
  expect(await client.getActivity(5)).toMatchObject({ id: 5, name: "Next week", available: false, availability_reason: "Opens next week" });
});

it("uses the module's resource name and unit rather than the downloaded filename", async () => {
  const client = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 1,
    fetchImpl: async (url) => String(url).includes("/lib/ajax/service.php")
      ? Response.json([{ error: false, data: { cm: { id: 5, name: "Lecture slides", modname: "resource", course: 2 } } }])
      : new Response("pdf", { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="week1.pdf"' } }),
  });
  expect(await client.getActivity(5)).toMatchObject({ id: 5, name: "Lecture slides", course_id: 2, target_name: "week1.pdf" });
});

it("marks manual completion and reports Moodle's refusal", async () => {
  const client = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 1,
    fetchImpl: async (_url, init) => {
      const [{ methodname, args }] = JSON.parse(String(init?.body));
      expect(methodname).toBe("core_completion_update_activity_completion_status_manually");
      return Response.json([{ error: false, data: { status: args.cmid === 5 } }]);
    },
  });
  expect(await client.completeActivity(5)).toEqual({ id: 5, completion: 1 });
  expect(await client.completeActivity(5, false)).toEqual({ id: 5, completion: 0 });
  await expect(client.completeActivity(6)).rejects.toMatchObject({ code: "upstream" });
});

it("keeps completion when the module metadata service is available", async () => {
  const client = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 1,
    fetchImpl: async (url, init) => {
      if (!String(url).includes("/lib/ajax/service.php")) return new Response("<h1>Welcome</h1><div class=box>Read me</div>");
      const [{ methodname }] = JSON.parse(String(init?.body));
      const data = methodname === "core_course_get_course_module"
        ? { cm: { id: 5, name: "Welcome", modname: "page", course: 2, completion: 1 } }
        : [{ id: 1, name: "Week one", section: 1, modules: [{ id: 5, name: "Welcome", modname: "page", completiondata: { state: 1 } }] }];
      return Response.json([{ error: false, data }]);
    },
  });
  expect(await client.getActivity(5)).toMatchObject({ id: 5, completion: 1 });
});
