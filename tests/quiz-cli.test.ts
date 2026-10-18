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

  it("passes one explicit --value into a single-input formulas answer", async () => {
    const single = fixture("quiz-attempt-formulas-single.html");
    const { calls, fetchImpl } = quizFetch({ "0": single }, savedQuestion(single, "question-5484577-7"));

    const result = await runQuiz(["quiz", "answer", "900", "32", "1", "--value", "4", "--yes", "--json"], fetchImpl);

    expect(result.code, result.stderr).toBe(0);
    expect(postedBody(calls.find(call => call.init?.method === "POST")!).get("q5484577:7_0_0")).toBe("4");
  }, CLI_TIMEOUT);

  it("passes repeated --value flags into a multi-field formulas answer", async () => {
    const multi = fixture("quiz-attempt-formulas.html");
    const { calls, fetchImpl } = quizFetch({ "0": multi }, savedQuestion(multi, "question-5484577-7"));

    const result = await runQuiz(["quiz", "answer", "900", "32", "1", "--value", "4", "--value", "32", "--yes", "--json"], fetchImpl);

    expect(result.code, result.stderr).toBe(0);
    const post = postedBody(calls.find(call => call.init?.method === "POST")!);
    expect(post.get("q5484577:7_0_0")).toBe("4");
    expect(post.get("q5484577:7_1_0")).toBe("32");
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
