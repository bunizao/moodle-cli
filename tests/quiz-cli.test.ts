import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { ENV_MOODLE_BASE_URL, ENV_MOODLE_SESSION } from "../src/constants.js";

const BASE = "https://school.example.edu";
const ATTEMPT = `${BASE}/mod/quiz/attempt.php?attempt=900&cmid=32`;
const CLI_TIMEOUT = process.platform === "win32" ? 45000 : 15000;
let homeDir = "";

beforeAll(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "moodle-quiz-cli-"));
});

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

interface SeenRequest {
  url: string;
  init?: RequestInit;
}

function htmlResponse(body: string, url: string): Response {
  const response = new Response(body, { headers: { "Content-Type": "text/html" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function savedQuestion(html: string, questionId: string): string {
  return html.replace(new RegExp(`(id="${questionId}"[\\s\\S]*?<div class="state">)Not yet answered`, "u"), "$1Answer saved");
}

function quizFetch(pages: Record<string, string>, savedHtml: string) {
  const calls: SeenRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    const url = new URL(call.url);
    if (url.pathname === "/my/") return htmlResponse(fixture("dashboard.html"), call.url);
    if (url.pathname === "/mod/quiz/attempt.php") {
      const page = url.searchParams.get("page") ?? "0";
      if (pages[page] !== undefined) return htmlResponse(pages[page], call.url);
    }
    if (url.pathname === "/mod/quiz/processattempt.php" && call.init?.method === "POST") return htmlResponse(savedHtml, ATTEMPT);
    throw new Error(`Unexpected fetch: ${call.url}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function postedBody(call: SeenRequest): URLSearchParams {
  return new URLSearchParams(typeof call.init?.body === "string" ? call.init.body : "");
}

async function runQuiz(args: string[], fetchImpl: typeof fetch): Promise<{ code: number; stderr: string; stdout: string }> {
  const stdout = buffer();
  const stderr = buffer();
  const code = await runCli(["node", "moodle", ...args], {
    env: {
      [ENV_MOODLE_BASE_URL]: BASE,
      [ENV_MOODLE_SESSION]: "cookie",
      MOODLE_NO_UPDATE_CHECK: "1",
    },
    fetchImpl,
    stdout,
    stderr,
    stdin: { isTTY: false } as NodeJS.ReadStream,
    homeDir,
  });
  return { code, stderr: stderr.text(), stdout: stdout.text() };
}

function buffer() {
  let value = "";
  return {
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text() {
      return value;
    },
  };
}

describe("quiz answer CLI", () => {
  it("passes one explicit --value into a text answer", async () => {
    const page0 = fixture("quiz-attempt-page-0.html");
    const page1 = fixture("quiz-attempt-page-1.html");
    const { calls, fetchImpl } = quizFetch({ "0": page0, "1": page1 }, savedQuestion(page1, "question-4000-3"));

    const result = await runQuiz(["quiz", "answer", "900", "32", "2", "--value", "hello", "--yes", "--json"], fetchImpl);

    expect(result.code, result.stderr).toBe(0);
    const post = calls.find(call => call.init?.method === "POST")!;
    expect(postedBody(post).get("q4000:3_answer")).toBe("<p>hello</p>");
  }, CLI_TIMEOUT);

  it("passes one explicit --value into a single-choice answer", async () => {
    const page0 = fixture("quiz-attempt-page-0.html");
    const { calls, fetchImpl } = quizFetch({ "0": page0 }, savedQuestion(page0, "question-4000-1"));

    const result = await runQuiz(["quiz", "answer", "900", "32", "1", "--value", "b", "--yes", "--json"], fetchImpl);

    expect(result.code, result.stderr).toBe(0);
    expect(postedBody(calls.find(call => call.init?.method === "POST")!).get("q4000:1_answer")).toBe("1");
  }, CLI_TIMEOUT);

  it("passes one explicit --value into a multiple-choice answer", async () => {
    const page0 = fixture("quiz-attempt-page-0.html");
    const page2 = fixture("quiz-attempt-page-2.html");
    const { calls, fetchImpl } = quizFetch({ "0": page0, "2": page2 }, savedQuestion(page2, "question-4000-4"));

    const result = await runQuiz(["quiz", "answer", "900", "32", "3", "--value", "a,c", "--yes", "--json"], fetchImpl);

    expect(result.code, result.stderr).toBe(0);
    const post = postedBody(calls.find(call => call.init?.method === "POST")!);
    expect(post.get("q4000:4_choice0")).toBe("1");
    expect(post.get("q4000:4_choice1")).toBe("0");
    expect(post.get("q4000:4_choice2")).toBe("1");
  }, CLI_TIMEOUT);

  it("passes repeated --value flags into a multi-field formulas answer", async () => {
    const multi = fixture("quiz-attempt-formulas.html");
    const { calls, fetchImpl } = quizFetch({ "0": multi }, fixture("moodle-5.0/formulas-attempt-saved.html"));

    const result = await runQuiz(["quiz", "answer", "900", "32", "1", "--value", "40 m/s", "--value", "40", "--value", "m/s", "--value", "40", "--value", "40", "--yes", "--json"], fetchImpl);

    expect(result.code, result.stderr).toBe(0);
    const post = postedBody(calls.find(call => call.init?.method === "POST")!);
    expect(post.get("q5:1_0_")).toBe("40 m/s");
    expect(post.get("q5:1_1_1")).toBe("m/s");
  }, CLI_TIMEOUT);

  it("rejects multiple explicit values for a non-fields question before posting", async () => {
    const page0 = fixture("quiz-attempt-page-0.html");
    const page1 = fixture("quiz-attempt-page-1.html");
    const { calls, fetchImpl } = quizFetch({ "0": page0, "1": page1 }, savedQuestion(page1, "question-4000-3"));

    const result = await runQuiz(["quiz", "answer", "900", "32", "2", "--value", "hello", "--value", "world", "--yes", "--json"], fetchImpl);

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain("takes exactly one --value, not 2");
    expect(calls.some(call => call.init?.method === "POST")).toBe(false);
  }, CLI_TIMEOUT);
});


describe("quiz attempt access errors", () => {
  for (const [path, message] of [
    ["startattempt.php?cmid=32", "access password again"],
    ["summary.php?attempt=900", "time ran out"],
    ["review.php?attempt=900", "already finished"],
  ]) {
    it(`explains a redirect to ${path.split("?")[0]}`, async () => {
      const fetchImpl: typeof fetch = async input => {
        const url = String(input);
        if (new URL(url).pathname === "/my/") return htmlResponse(fixture("dashboard.html"), url);
        return htmlResponse(fixture("quiz-review.html"), `${BASE}/mod/quiz/${path}`);
      };
      const result = await runQuiz(["quiz", "show", "900", "32", "--json"], fetchImpl);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain(message);
      if (path.startsWith("startattempt")) expect(result.stderr).toContain("moodle quiz start 32 --password");
    });
  }
});


describe("real formulas attempt", () => {
  it("shows the timer and named fields in both JSON and human output", async () => {
    const page = fixture("quiz-attempt-formulas.html");
    const { fetchImpl } = quizFetch({ "0": page }, fixture("moodle-5.0/formulas-attempt-saved.html"));
    const result = await runQuiz(["quiz", "show", "900", "32", "--json"], fetchImpl);
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout).attempt;
    expect(output.time_left_s).toBe(3557);
    expect(Date.parse(output.ends_at)).toBeGreaterThan(Date.now() + 3555_000);
    expect(output.questions[0].fields.map((field: { label: string }) => field.label)).toContain("Unit for part 2");
    const human = await runQuiz(["quiz", "show", "900", "32", "--table"], fetchImpl);
    expect(human.stdout).toContain("Time left: 59m 17s");
    expect(human.stdout).toContain("Unit for part 2: (empty)");
  });

  it("uses the server clock for a stable deadline across show and answer", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (new URL(url).pathname === "/my/") return htmlResponse(fixture("dashboard.html"), url);
      const saved = init?.method === "POST";
      const response = htmlResponse(fixture(saved ? "moodle-5.0/formulas-attempt-saved.html" : "quiz-attempt-formulas.html"), ATTEMPT);
      response.headers.set("date", saved ? "Sun, 18 Oct 2026 08:44:42 GMT" : "Sun, 18 Oct 2026 08:41:05 GMT");
      return response;
    };
    const shown = await runQuiz(["quiz", "show", "900", "32", "--json"], fetchImpl);
    const answered = await runQuiz(["quiz", "answer", "900", "32", "1", "--value", "40 m/s", "--value", "40", "--value", "m/s", "--value", "40", "--value", "40", "--yes", "--json"], fetchImpl);
    expect(shown.code, shown.stderr).toBe(0);
    expect(answered.code, answered.stderr).toBe(0);
    const before = JSON.parse(shown.stdout).attempt;
    const after = JSON.parse(answered.stdout).attempt;
    expect(before.time_left_s).toBe(3557);
    expect(after.time_left_s).toBe(3340);
    expect(before.ends_at).toBe("2026-10-18T09:40:22.000Z");
    expect(after.ends_at).toBe(before.ends_at);
  });

});
