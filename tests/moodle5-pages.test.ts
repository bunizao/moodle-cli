import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAssignmentHtml, parseFolderHtml, parseLinkHtml, parsePageHtml, parseQuizHtml } from "../src/scraper.js";

// Pages from a stock Moodle 5.0 site under Boost and under Classic, trimmed to the page
// header and main region; every reader returned the same result on the full page. The
// expected values are what the site was generated with, not what the readers returned.
const BASE = "https://moodle.example.edu";
const COURSE = 16;

// Classic keeps the course name in the h1 and names the activity in the main region's h2.
describe.each([["Boost", ""], ["Classic", "classic-"]])("readers on stock Moodle 5.0 pages (%s)", (_theme, prefix) => {
  const page = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "moodle-5.0", `${prefix}${name}.html`), "utf8");

  it("reads an open assignment with its course and due date", () => {
    expect(parseAssignmentHtml(page("assign-due"), 98, BASE)).toMatchObject({
      name: "Essay One",
      // The breadcrumb also links /course/section.php?id=93, which is a section, not the course.
      course_id: COURSE,
      section_name: "New section",
      due_pretty: "Tuesday, 6 October 2026, 3:35 PM",
      submission_status: "No submissions have been made yet",
      grading_status: "Not graded",
    });
  });

  it("reads a graded assignment's grade, grader and feedback", () => {
    expect(parseAssignmentHtml(page("assign-graded"), 99, BASE)).toMatchObject({
      name: "Essay Zero",
      course_id: COURSE,
      submission_status: "Submitted for grading",
      grading_status: "Graded",
      grade: "8.00 / 10.00",
      // A user without a picture shows initials beside the name; they are not part of it.
      graded_by: "Tess Teacher",
      feedback_comments: "Good work",
    });
  });

  it("reads a quiz and its finished attempt", () => {
    const quiz = parseQuizHtml(page("quiz"), 100, BASE);
    expect(quiz).toMatchObject({ name: "Quiz One", course_id: COURSE, attempts_allowed: "2", closes_pretty: "Tuesday, 13 October 2026, 3:35 PM" });
    expect(quiz.attempts).toEqual([expect.objectContaining({ id: 6, number: 1, status: "Finished", grade: "5.00 out of 10.00 (50%)" })]);
  });

  it("reads a folder's files, a link's target and a page's text", () => {
    expect(parseFolderHtml(page("folder"), 102, BASE)).toMatchObject({ name: "Readings", course_id: COURSE, files: ["reading1.pdf", "reading2.txt"] });
    expect(parseLinkHtml(page("url"), 103, BASE)).toMatchObject({ name: "Course Website", course_id: COURSE, target_url: "https://example.org/" });
    expect(parsePageHtml(page("page"), 104, BASE)).toMatchObject({ name: "Welcome Page", course_id: COURSE, content_text: expect.stringContaining("Welcome to Lab Course One.") });
  });

  it("names the activity when the course's full name is also its short name", () => {
    // The document title then contains both headings.
    const html = page("page").replaceAll("Lab Course One", "LAB101");
    expect(parsePageHtml(html, 104, BASE).name).toBe("Welcome Page");
  });
});

// A young Moodle 5.0 site's course page, read as HTML because the contents services are
// unavailable. Section ids start at 1 there, the same numbers as the sections themselves.
describe("course page on a young Moodle 5.0 site", () => {
  it("keeps every section and knows which activities can be opened", async () => {
    const { createMoodleClientCore } = await import("../src/moodle-client-core.js");
    const html = readFileSync(join(import.meta.dirname, "fixtures", "moodle-5.0", "course-young-site.html"), "utf8");
    const client = createMoodleClientCore(BASE, {
      cookie: { name: "MoodleSession", value: "cookie" }, sesskey: "key", userid: 3,
      unavailable: ["core_course_get_contents", "core_courseformat_get_state"],
      fetchImpl: async () => new Response(html, { headers: { "content-type": "text/html" } }),
    });
    const sections = await client.getCourseContents(2);
    // Section 0's id (1) once collided with section 1's number and section 1 was dropped.
    expect(sections.map(s => [s.section, s.activities.length])).toEqual([[0, 1], [1, 7], [2, 2], [3, 0]]);
    const byName = new Map(sections.flatMap(s => s.activities).map(a => [a.name, a]));
    expect(byName.get("Essay One")?.visible).toBe(true);
    // Restricted until a date: listed without a link, so it cannot be opened yet.
    expect(byName.get("Locked Task")?.visible).toBe(false);
  });

  it("keeps a link-less activity with no restriction visible", async () => {
    const { createMoodleClientCore } = await import("../src/moodle-client-core.js");
    // As Moodle lists a subsection: no link of its own and nothing restricting it.
    const html = readFileSync(join(import.meta.dirname, "fixtures", "moodle-5.0", "course-young-site.html"), "utf8")
      .replace(/<div[^>]*\bavailabilityinfo\b[\s\S]*?<\/div>\s*<\/div>/u, "");
    const client = createMoodleClientCore(BASE, {
      cookie: { name: "MoodleSession", value: "cookie" }, sesskey: "key", userid: 3,
      unavailable: ["core_course_get_contents", "core_courseformat_get_state"],
      fetchImpl: async () => new Response(html, { headers: { "content-type": "text/html" } }),
    });
    const activities = (await client.getCourseContents(2)).flatMap(s => s.activities);
    expect(activities.find(a => a.name === "Locked Task")?.visible).toBe(true);
  });
});
