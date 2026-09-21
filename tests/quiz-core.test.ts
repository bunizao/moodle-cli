import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { answerQuizQuestion, finishQuizAttempt, getAttemptPage, parseAttemptPage, startQuizAttempt, type QuizDeps } from "../src/moodle-quiz-core.js";
import { redactSesskey } from "../src/cli.js";

const BASE = "https://school.example.edu";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ATTEMPT = `${BASE}/mod/quiz/attempt.php?attempt=900&cmid=32`;

interface Call { url: string; method: string; body: URLSearchParams }

// Routes answer with the page Moodle would land on; a route may inspect the posted body.
function fakeDeps(routes: Record<string, (call: Call) => { url: string; html: string }>): QuizDeps & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    baseUrl: BASE,
    async request(url, init) {
      const call: Call = { url, method: init?.method ?? "GET", body: new URLSearchParams(typeof init?.body === "string" ? init.body : "") };
      calls.push(call);
      const key = `${call.method} ${new URL(url).pathname}`;
      const route = routes[key];
      if (!route) throw new Error(`unexpected ${key}`);
      const landed = route(call);
      return { url: landed.url, text: async () => landed.html } as Response;
    },
    fail: (message) => new Error(`fail: ${message}`),
    usage: (message, hint) => new Error(`usage: ${message}${hint ? ` (${hint})` : ""}`),
  };
}

function saved(html: string, slot: number): string {
  return html.replace(new RegExp(`(id="question-4000-${slot}"[\\s\\S]*?<div class="state">)Not yet answered`, "u"), "$1Answer saved");
}

describe("quiz attempt pages", () => {
  const deps = { baseUrl: BASE, fail: (message: string) => new Error(message) };

  it("reads a single-choice page with its navigation", () => {
    const page = parseAttemptPage(fixture("quiz-attempt-page-0.html"), ATTEMPT, deps);
    expect(page).toMatchObject({ attempt: 900, quiz_id: 32, name: "Quiz 1", page: 0, pages: 3 });
    expect(page.questions).toEqual([expect.objectContaining({ slot: 1, number: "1", kind: "choice", type: "multichoice", state: "Not yet answered", text: "Which value of x satisfies 2x + 1 = 7?" })]);
    expect(page.questions[0].options).toEqual([
      { key: "a", value: "0", text: "x = 2", chosen: false },
      { key: "b", value: "1", text: "x = 3", chosen: false },
      { key: "c", value: "2", text: "x = 4", chosen: false },
    ]);
    expect(page.navigation).toEqual([
      { slot: 1, number: "1", page: 0, state: "Not yet answered" },
      { slot: 2, number: "i", page: 1, state: "Not yet viewed" },
      { slot: 3, number: "2", page: 1, state: "Not yet answered" },
      { slot: 4, number: "3", page: 2, state: "Not yet answered" },
    ]);
    expect(page.form.fields).toContainEqual(["q4000:1_:sequencecheck", "1"]);
    expect(page.form.fields).toContainEqual(["sesskey", "FIXTUREKEY"]);
  });

  it("tells information blocks, essays and multiple-choice apart by their inputs", () => {
    const page1 = parseAttemptPage(fixture("quiz-attempt-page-1.html"), `${ATTEMPT}&page=1`, deps);
    expect(page1.questions.map(q => [q.number, q.kind])).toEqual([["i", "info"], ["2", "text"]]);
    expect(page1.questions[1]).toMatchObject({ type: "essay", answer: "" });
    const page2 = parseAttemptPage(fixture("quiz-attempt-page-2.html"), `${ATTEMPT}&page=2`, deps);
    expect(page2.questions[0]).toMatchObject({ number: "3", kind: "multi" });
    expect(page2.questions[0].options?.map(o => o.text)).toEqual(["2", "9", "11"]);
  });

  it("keeps the form out of what callers see", async () => {
    const deps = fakeDeps({ "GET /mod/quiz/attempt.php": () => ({ url: ATTEMPT, html: fixture("quiz-attempt-page-0.html") }) });
    const page = await getAttemptPage(deps, 900, 32, 0);
    expect(JSON.stringify(page)).not.toContain("FIXTUREKEY");
  });

  it("refuses a finished attempt with the review link", async () => {
    const deps = fakeDeps({ "GET /mod/quiz/attempt.php": () => ({ url: `${BASE}/mod/quiz/review.php?attempt=900`, html: fixture("quiz-review.html") }) });
    await expect(getAttemptPage(deps, 900, 32, 0)).rejects.toThrow(/already finished.*review\.php/u);
  });
});

describe("startQuizAttempt", () => {
  it("posts the view page's start form and returns the first attempt page", async () => {
    const deps = fakeDeps({
      "GET /mod/quiz/view.php": () => ({ url: `${BASE}/mod/quiz/view.php?id=32`, html: fixture("quiz-start.html") }),
      "POST /mod/quiz/startattempt.php": () => ({ url: ATTEMPT, html: fixture("quiz-attempt-page-0.html") }),
    });
    const page = await startQuizAttempt(deps, 32);
    expect(page.attempt).toBe(900);
    expect(deps.calls[1].body.get("cmid")).toBe("32");
    expect(deps.calls[1].body.get("sesskey")).toBe("FIXTUREKEY");
  });

  it("refuses a quiz that needs the Safe Exam Browser", async () => {
    const html = fixture("quiz-start.html").replace("startattempt.php", "https://safeexambrowser.org/launch");
    const deps = fakeDeps({ "GET /mod/quiz/view.php": () => ({ url: `${BASE}/mod/quiz/view.php?id=32`, html }) });
    await expect(startQuizAttempt(deps, 32)).rejects.toThrow(/Safe Exam Browser/u);
  });

  it("refuses a password-protected quiz instead of guessing", async () => {
    const preflight = `<form method="post" action="${BASE}/mod/quiz/startattempt.php"><input type="hidden" name="cmid" value="32"><input type="hidden" name="sesskey" value="FIXTUREKEY"><input type="password" name="quizpassword"><input type="submit" name="submitbutton" value="Start attempt"></form>`;
    const deps = fakeDeps({
      "GET /mod/quiz/view.php": () => ({ url: `${BASE}/mod/quiz/view.php?id=32`, html: fixture("quiz-start.html") }),
      "POST /mod/quiz/startattempt.php": () => ({ url: `${BASE}/mod/quiz/startattempt.php`, html: preflight }),
    });
    await expect(startQuizAttempt(deps, 32)).rejects.toThrow(/needs a password/u);
  });
});

describe("answerQuizQuestion", () => {
  function attemptDeps(onPost: (call: Call) => { url: string; html: string }) {
    return fakeDeps({
      "GET /mod/quiz/attempt.php": ({ url }) => {
        const page = new URL(url).searchParams.get("page") ?? "0";
        return { url, html: fixture(`quiz-attempt-page-${page}.html`) };
      },
      "POST /mod/quiz/processattempt.php": onPost,
    });
  }

  it("picks a single-choice option by letter and stays on the page to verify it", async () => {
    const deps = attemptDeps(() => ({ url: ATTEMPT, html: saved(fixture("quiz-attempt-page-0.html"), 1) }));
    const page = await answerQuizQuestion(deps, { attemptId: 900, quizId: 32, question: "1", value: "b" });
    const post = deps.calls.find(call => call.method === "POST")!;
    expect(post.url).toBe(`${BASE}/mod/quiz/processattempt.php?cmid=32`);
    expect(post.body.get("q4000:1_answer")).toBe("1");
    expect(post.body.getAll("q4000:1_answer")).toEqual(["1"]);
    expect(post.body.get("q4000:1_:sequencecheck")).toBe("1");
    expect(post.body.get("thispage")).toBe("0");
    expect(post.body.get("nextpage")).toBe("0");
    expect(post.body.get("slots")).toBe("1");
    expect(post.body.has("next")).toBe(false);
    expect(page.questions[0].state).toBe("Answer saved");
  });

  it("finds the question's page from the navigation and sends an essay as HTML paragraphs", async () => {
    const deps = attemptDeps(() => ({ url: `${ATTEMPT}&page=1`, html: saved(fixture("quiz-attempt-page-1.html"), 3) }));
    await answerQuizQuestion(deps, { attemptId: 900, quizId: 32, question: "2", value: "First line\nsecond line\n\nNew paragraph & <tag>" });
    expect(deps.calls.map(call => `${call.method} ${new URL(call.url).searchParams.get("page") ?? "0"}`)).toEqual(["GET 0", "GET 1", "POST 0"]);
    const post = deps.calls[2];
    expect(post.body.get("q4000:3_answer")).toBe("<p>First line<br>second line</p><p>New paragraph &amp; &lt;tag&gt;</p>");
    expect(post.body.get("q4000:3_answerformat")).toBe("1");
    expect(post.body.get("q4000:2_-seen")).toBe("1");
    expect(post.body.get("nextpage")).toBe("1");
  });

  it("ticks several boxes for a multiple-choice question", async () => {
    const deps = attemptDeps(() => ({ url: `${ATTEMPT}&page=2`, html: saved(fixture("quiz-attempt-page-2.html"), 4) }));
    await answerQuizQuestion(deps, { attemptId: 900, quizId: 32, question: "3", value: "a, c" });
    const post = deps.calls.at(-1)!;
    expect([post.body.get("q4000:4_choice0"), post.body.get("q4000:4_choice1"), post.body.get("q4000:4_choice2")]).toEqual(["1", "0", "1"]);
  });

  it("explains a wrong option, a second option on a single choice, and an information block", async () => {
    const deps = attemptDeps(() => { throw new Error("must not post"); });
    await expect(answerQuizQuestion(deps, { attemptId: 900, quizId: 32, question: "1", value: "z" })).rejects.toThrow(/no option 'z'.*a, b, c/u);
    await expect(answerQuizQuestion(deps, { attemptId: 900, quizId: 32, question: "1", value: "a,b" })).rejects.toThrow(/takes one option/u);
    await expect(answerQuizQuestion(deps, { attemptId: 900, quizId: 32, question: "i", value: "x" })).rejects.toThrow(/information block/u);
    await expect(answerQuizQuestion(deps, { attemptId: 900, quizId: 32, question: "9", value: "a" })).rejects.toThrow(/no question 9/u);
  });

  it("fails when Moodle re-renders the question still unanswered", async () => {
    const deps = attemptDeps(() => ({ url: ATTEMPT, html: fixture("quiz-attempt-page-0.html") }));
    await expect(answerQuizQuestion(deps, { attemptId: 900, quizId: 32, question: "1", value: "b" })).rejects.toThrow(/still reports question 1 as "Not yet answered"/u);
  });
});

describe("finishQuizAttempt", () => {
  it("posts the summary page's finish form and reads the review", async () => {
    const deps = fakeDeps({
      "GET /mod/quiz/summary.php": ({ url }) => ({ url, html: fixture("quiz-summary.html") }),
      "POST /mod/quiz/processattempt.php": () => ({ url: `${BASE}/mod/quiz/review.php?attempt=900&cmid=32`, html: fixture("quiz-review.html") }),
    });
    const receipt = await finishQuizAttempt(deps, 900, 32);
    const post = deps.calls[1];
    expect(post.body.get("finishattempt")).toBe("1");
    expect(post.body.get("attempt")).toBe("900");
    expect(receipt.summary.map(row => row.state)).toEqual(["Answer saved", "Not yet answered", "Answer saved"]);
    expect(receipt.review?.status).toBe("Finished");
    expect(receipt.url).toContain("review.php");
  });

  it("falls back to the quiz page's attempt list when the review is withheld", async () => {
    const deps = fakeDeps({
      "GET /mod/quiz/summary.php": ({ url }) => ({ url, html: fixture("quiz-summary.html") }),
      "POST /mod/quiz/processattempt.php": () => ({ url: `${BASE}/mod/quiz/view.php?id=32`, html: fixture("quiz.html").replace("attempt=777", "attempt=900") }),
    });
    const receipt = await finishQuizAttempt(deps, 900, 32);
    expect(receipt.result?.status).toBe("Finished");
  });
});

describe("redactSesskey", () => {
  it("hides the key in form fields, scripts and URLs without mangling the attribute name", () => {
    const html = '<input type="hidden" name="sesskey" value="abcDEF1234"> M.cfg = {"sesskey":"abcDEF1234"} href="x?sesskey=abcDEF1234&amp;y=1"';
    const out = redactSesskey(html);
    expect(out).not.toContain("abcDEF1234");
    expect(out).toContain('name="sesskey" value="REDACTED"');
    expect(out).toContain('"sesskey":"REDACTED"');
    expect(out).toContain("sesskey=REDACTED");
  });
});
