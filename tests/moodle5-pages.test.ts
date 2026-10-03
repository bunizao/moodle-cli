import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createMoodleClientCore } from "../src/moodle-client-core.js";
import { isOtherMoodlePage, parseAssignmentHtml, parseFolderHtml, parseLinkHtml, parsePageHtml, parseQuizHtml, parseUnavailableNotice } from "../src/scraper.js";

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

const BASE_URL = "https://school.example.edu";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/moodle-5.0/${name}`, import.meta.url), "utf8");
}

// Moodle refuses every activity the same way: a 303 to the course page, which prints the notice.
function refusingSite(modname: string) {
  const coursePage = fixture("course-page-activity-unavailable.html");
  return createMoodleClientCore(BASE_URL, {
    cookie: { name: "MoodleSession", value: "session-cookie" },
    sesskey: "fixturesesskey",
    userid: 7,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/lib/ajax/service.php") {
        return Response.json([{ index: 0, error: false, data: { cm: { id: 42, course: 101, modname } } }]);
      }
      if (url.pathname === `/mod/${modname}/view.php`) {
        return new Response(null, { status: 303, headers: { location: `${BASE_URL}/course/view.php?id=101` } });
      }
      if (url.pathname === "/course/view.php") {
        return new Response(coursePage, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
}

describe("Moodle 5.0 pages", () => {
  it.each(["assign", "quiz", "resource", "url", "page", "folder"])("refuses to read the course page as a %s", async (modname) => {
    await expect(refusingSite(modname).getActivity(42)).rejects.toMatchObject({
      message: "Activity 42 is not available to you. Not available unless: It is on or after 30 October 2026, 12:00 AM",
      moodleErrorCode: "requireloginerror",
    });
  });

  it("tells an activity's own page from another Moodle page", () => {
    const page = (bodyId: string, instance: number) =>
      `<html><head><script>M.cfg = {"contextid":3022,"contextInstanceId":${instance}};</script></head><body id="${bodyId}"></body></html>`;
    expect(isOtherMoodlePage(page("page-mod-assign-view", 42), "assign", 42)).toBe(false);
    // A course whose id happens to equal the cmid is still the course page.
    expect(isOtherMoodlePage(page("page-course-view-topics", 42), "assign", 42)).toBe(true);
    // Framesets and served HTML files carry no page identity, so the parsers keep them.
    expect(isOtherMoodlePage("<html><frameset rows=\"130,*\"></frameset></html>", "resource", 42)).toBe(false);
  });

  it("reports the hidden notice when an activity has no conditions to show", () => {
    const notice = `<span class="notifications" id="user-notifications"><div class="alert alert-danger alert-block fade in alert-dismissible" role="alert">
      This activity is currently hidden<button type="button" class="btn-close" data-bs-dismiss="alert"><span class="visually-hidden">Dismiss this notification</span></button>
    </div></span>`;
    expect(parseUnavailableNotice(notice)).toBe("This activity is currently hidden");
  });
});
