import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MoodleClient } from "../src/client.js";

const BASE = "https://school.example.edu";
const ATTEMPT = `${BASE}/mod/quiz/attempt.php?attempt=900&cmid=32`;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function htmlResponse(html: string, url: string, date?: string): Response {
  const response = new Response(html, { headers: { "content-type": "text/html", ...(date ? { date } : {}) } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function client(fetchImpl: typeof fetch): MoodleClient {
  return new MoodleClient(BASE, {
    cookie: { name: "MoodleSession", value: "fixture-session" },
    sesskey: "FIXTUREKEY",
    userid: 7,
    fetchImpl,
  });
}

describe("quiz client", () => {
  it("resumes the existing attempt through its password pre-flight form", async () => {
    const posts: URLSearchParams[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      if (path === "/mod/quiz/view.php") {
        return htmlResponse(`<a href="${ATTEMPT}">Continue your attempt</a>`, url);
      }
      if (path === "/mod/quiz/attempt.php") {
        return htmlResponse(`<form method="post" action="${BASE}/mod/quiz/startattempt.php"><input type="hidden" name="cmid" value="32"><input type="hidden" name="sesskey" value="FIXTUREKEY"><input type="hidden" name="attempt" value="900"><input type="password" name="quizpassword"></form>`, `${BASE}/mod/quiz/startattempt.php?cmid=32`);
      }
      if (path === "/mod/quiz/startattempt.php" && init?.method === "POST") {
        const body = new URLSearchParams(String(init.body));
        posts.push(body);
        if (body.get("quizpassword") === "open-sesame" && body.get("attempt") === "900") {
          return htmlResponse(fixture("quiz-attempt-page-1.html"), `${ATTEMPT}&page=1`);
        }
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    };

    const page = await client(fetchImpl).startQuizAttempt(32, { password: async () => "open-sesame" });

    expect(page).toMatchObject({ attempt: 900, page: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].get("attempt")).toBe("900");
  });
});
