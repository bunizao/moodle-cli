import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createMoodleClientCore } from "../src/moodle-client-core.js";

it("retains unlinked manual marks and category totals from a real grade report", async () => {
  const html = readFileSync(new URL("./fixtures/moodle-5.0/grades-manual-category.html", import.meta.url), "utf8");
  const client = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 3,
    fetchImpl: async () => new Response(html),
  });
  const grades = await client.getCourseGrades(8);
  expect(grades.items.find(item => item.name === "Midterm exam")).toMatchObject({ grade: "78.00", feedback: "Solid midterm", url: "", modname: "manual" });
  expect(grades.items.find(item => item.modname === "category")).toMatchObject({ name: "Exams total", grade: "78.00" });
  expect(grades.total_grade).not.toBe("");
  const translated = createMoodleClientCore("https://moodle.example.edu", {
    cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 3,
    fetchImpl: async () => new Response(html.replaceAll("Course total", "Gesamtergebnis")),
  });
  expect((await translated.getCourseGrades(8)).total_grade).toBe(grades.total_grade);
});
