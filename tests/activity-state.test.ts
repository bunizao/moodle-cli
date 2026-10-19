import { readFileSync } from "node:fs";
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

it("lists a restricted course-state activity with the condition from its course page", async () => {
  let coursePages = 0;
  const client = createMoodleClientCore("https://school.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 3,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/course/view.php") {
        coursePages++;
        return new Response(readFileSync(new URL("./fixtures/moodle-5.0/course-restrictions.html", import.meta.url), "utf8"));
      }
      const [{ methodname }] = JSON.parse(String(init?.body));
      if (methodname === "core_course_get_contents") return Response.json([{ error: true, exception: { errorcode: "servicenotavailable", message: "Web service is not available" } }]);
      expect(methodname).toBe("core_courseformat_get_state");
      return Response.json([{ error: false, data: JSON.stringify({
        section: [{ id: "94", section: 2, title: "New section", cmlist: ["150"] }],
        cm: [{ id: "150", sectionid: "94", name: "Locked Task", module: "assign", visible: true, uservisible: false, hascmrestrictions: true, completionstate: 0 }],
      }) }]);
    },
  });
  expect(await client.getActivities(16)).toMatchObject([{ id: 150, available: false, availability_reason: "Available from 17 November 2026, 12:57 PM", completion: 0 }]);
  await client.getCourseContents(16);
  expect(coursePages).toBe(1);
});

it.each([
  { uservisible: true },
  { uservisible: false, availableinfo: "<p>Opens next week</p>" },
])("keeps course-state reads on AJAX when no restriction text is missing: %j", async (availability) => {
  const client = createMoodleClientCore("https://school.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 3,
    fetchImpl: async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/lib/ajax/service.php");
      const [{ methodname }] = JSON.parse(String(init?.body));
      if (methodname === "core_course_get_contents") return Response.json([{ error: true, exception: { errorcode: "servicenotavailable", message: "Web service is not available" } }]);
      return Response.json([{ error: false, data: JSON.stringify({
        section: [{ id: "94", section: 2, title: "New section", cmlist: ["150"] }],
        cm: [{ id: "150", sectionid: "94", name: "Task", module: "assign", visible: true, ...availability }],
      }) }]);
    },
  });
  expect((await client.getActivities(16))[0].id).toBe(150);
});
