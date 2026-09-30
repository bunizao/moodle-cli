import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createMoodleClientCore } from "../src/moodle-client-core.js";
import { isOtherMoodlePage, parseUnavailableNotice } from "../src/scraper.js";

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
