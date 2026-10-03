import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createMoodleClientCore } from "../src/moodle-client-core.js";
import { parseAssignmentHtml, parsePageContext, parseQuizHtml, parseQuizReviewHtml } from "../src/scraper.js";
import { labelRequests, siteLabelsFrom } from "../src/site-labels.js";

// Pages and core_get_strings answers from a stock Moodle 5.0 site: once with the student's
// language set to German, once in English with "Submission status" customised by the site.
const BASE = "https://moodle.example.edu";
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "moodle-5.0", name), "utf8");
const labels = (set: string) => siteLabelsFrom(JSON.parse(fixture(`${set}-strings.json`)));

describe("readers on a German site", () => {
  const de = labels("de");

  it("could not read the assignment with English labels alone", () => {
    expect(parseAssignmentHtml(fixture("de-assign-graded.html"), 99, BASE)).toMatchObject({ submission_status: "", grade: "", due_pretty: "" });
  });

  it("reads assignments with the site's own labels", () => {
    expect(parseAssignmentHtml(fixture("de-assign-due.html"), 98, BASE, de)).toMatchObject({
      name: "Essay One",
      due_pretty: "Dienstag, 6. Oktober 2026, 15:35",
      submission_status: "Bisher wurden keine Aufgaben abgegeben",
      grading_status: "Nicht bewertet",
    });
    expect(parseAssignmentHtml(fixture("de-assign-graded.html"), 99, BASE, de)).toMatchObject({
      submission_status: "Zur Bewertung abgegeben",
      grading_status: "Bewertet",
      grade: "8,00 / 10,00",
      graded_by: "Tess Teacher",
      feedback_comments: "Good work",
    });
  });

  it("reads the quiz and the review summary with the site's own labels", () => {
    const quiz = parseQuizHtml(fixture("de-quiz.html"), 100, BASE, de);
    expect(quiz).toMatchObject({ attempts_allowed: "2", closes_pretty: "Dienstag, 13. Oktober 2026, 15:35", grade: "5,00 von 10,00 (50%)" });
    expect(quiz.attempts).toEqual([expect.objectContaining({ id: 6, status: "Beendet", marks: "1,00/2,00", grade: "5,00 von 10,00 (50%)" })]);
    expect(parseQuizReviewHtml(fixture("de-review.html"), 6, BASE, de)).toMatchObject({ status: "Beendet", marks: "1,00/2,00", grade: "5,00 von 10,00 (50%)", duration: "5 Minuten" });
  });
});

describe("readers on a site that customised a string", () => {
  it("follows the site's wording for the submission status", () => {
    const html = fixture("custom-assign-due.html");
    expect(html).toContain("Status of your work");
    expect(parseAssignmentHtml(html, 98, BASE).submission_status).toBe("");
    expect(parseAssignmentHtml(html, 98, BASE, labels("custom")).submission_status).toBe("No submissions have been made yet");
  });
});

describe("site labels", () => {
  it("drops strings the site does not have", () => {
    const parsed = siteLabelsFrom([
      { component: "mod_assign", stringid: "submissionstatus", string: "Abgabestatus" },
      { component: "core", stringid: "gradenoun", string: "[[gradenoun]]" },
    ]);
    expect(parsed).toEqual({ "Submission status": ["Abgabestatus"] });
  });

  it("asks the site once per client and falls back to English when it refuses", async () => {
    for (const refuse of [false, true]) {
      const asked: string[] = [];
      const client = createMoodleClientCore(BASE, {
        cookie: { name: "MoodleSession", value: "cookie" },
        sesskey: "key",
        userid: 7,
        fetchImpl: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/lib/ajax/service.php") {
            const [call] = JSON.parse(String(init?.body)) as [{ methodname: string; args: { strings: unknown[] } }];
            asked.push(call.methodname);
            expect(call.args.strings).toEqual(labelRequests());
            return Response.json([refuse
              ? { error: true, exception: { errorcode: "servicenotavailable", message: "disabled" } }
              : { error: false, data: JSON.parse(fixture("de-strings.json")) }]);
          }
          return new Response(fixture(url.pathname.includes("/quiz/") ? "de-quiz.html" : "de-assign-due.html"), { headers: { "content-type": "text/html" } });
        },
      });
      const assignment = await client.getAssignment(98);
      await client.getQuiz(100);
      expect(asked).toEqual(["core_get_strings"]);
      expect(assignment.submission_status).toBe(refuse ? "" : "Bisher wurden keine Aufgaben abgegeben");
    }
  });

  it("asks again after a failed request instead of keeping English for the client's life", async () => {
    let calls = 0;
    const client = createMoodleClientCore(BASE, {
      cookie: { name: "MoodleSession", value: "cookie" },
      sesskey: "key",
      userid: 7,
      fetchImpl: async input => {
        const url = new URL(String(input));
        if (url.pathname === "/lib/ajax/service.php") {
          // A proxy's error page in place of Moodle's answer, then the answer.
          return ++calls === 1 ? new Response("<html>Bad gateway</html>", { status: 502 }) : Response.json([{ error: false, data: JSON.parse(fixture("de-strings.json")) }]);
        }
        return new Response(fixture("de-assign-due.html"), { headers: { "content-type": "text/html" } });
      },
    });
    expect((await client.getAssignment(98)).submission_status).toBe("");
    expect((await client.getAssignment(98)).submission_status).toBe("Bisher wurden keine Aufgaben abgegeben");
    expect(calls).toBe(2);
  });
});

it("reads Moodle's resolved inherited timezone and session language", () => {
  const html = '<html lang="de"><script>M.cfg = {"sesskey":"fixture","userId":7,"timezone":"99","usertimezone":"Europe/London","language":"de"};</script></html>';
  expect(parsePageContext(html, BASE).user_info).toMatchObject({ timezone: "Europe/London", lang: "de" });
});

it("resolves Moodle's localized display timezone to an IANA name", () => {
  const html = '<html lang="de"><script>M.cfg = {"sesskey":"fixture","userId":7,"usertimezone":"Europa/London","language":"de"};</script></html>';
  expect(parsePageContext(html, BASE).user_info).toMatchObject({ timezone: "Europe/London", lang: "de" });
});
