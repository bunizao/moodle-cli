import type {
  MoodleSessionUpstream,
  SessionCandidate,
  SessionTouchResult,
  SessionValidationFailure,
  SessionValidationSuccess,
} from "./session-broker.js";

const DASHBOARD_PATH = "/my/";
const AJAX_PATH = "/lib/ajax/service.php";
const SESSION_TOUCH = "core_session_touch";
const SESSION_TIME_REMAINING = "core_session_time_remaining";

export class FetchMoodleSessionUpstream implements MoodleSessionUpstream {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(origin: string, fetchImpl?: typeof fetch) {
    this.origin = new URL(origin).origin;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async validate(candidate: SessionCandidate): Promise<SessionValidationSuccess | SessionValidationFailure> {
    if (new URL(candidate.moodleOrigin).origin !== this.origin) return { valid: false, code: "SESSION_INVALID" };
    const response = await this.fetchImpl(`${this.origin}${DASHBOARD_PATH}`, {
      method: "GET",
      headers: { cookie: `${candidate.cookieName}=${candidate.cookieValue}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) return { valid: false, code: "SESSION_EXPIRED" };
    if (response.status >= 500) throw new Error(`Moodle returned HTTP ${response.status}.`);
    if (!response.ok) return { valid: false, code: "SESSION_INVALID" };

    const html = await response.text();
    const sesskey = firstMatch(html, [
      /"sesskey"\s*:\s*"([^"]+)"/,
      /\bsesskey\s*:\s*'([^']+)'/,
      /name=["']sesskey["'][^>]*value=["']([^"']+)["']/i,
    ]);
    if (!sesskey) return { valid: false, code: "SESSION_EXPIRED" };
    const userId = firstMatch(html, [
      /"userid"\s*:\s*(\d+)/,
      /data-userid=["'](\d+)["']/i,
      /\buserid\s*:\s*['"]?(\d+)/,
    ]);
    if (!userId || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) return { valid: false, code: "SESSION_INVALID" };
    const rotatedCookie = cookieFromSetCookie(response.headers.get("set-cookie"), candidate.cookieName);
    return {
      valid: true,
      sesskey,
      moodleUserId: userId ? Number(userId) : 0,
      remainingSeconds: null,
      ...(rotatedCookie ? { rotatedCookie } : {}),
    };
  }

  async touch(session: {
    moodleOrigin: string;
    cookieName: string;
    cookieValue: string;
    sesskey: string;
  }): Promise<SessionTouchResult> {
    if (new URL(session.moodleOrigin).origin !== this.origin) return { alive: false, remainingSeconds: null };
    const methods = [SESSION_TOUCH, SESSION_TIME_REMAINING];
    const search = new URLSearchParams({ sesskey: session.sesskey, info: methods.join(",") });
    const response = await this.fetchImpl(`${this.origin}${AJAX_PATH}?${search}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${session.cookieName}=${session.cookieValue}`,
      },
      body: JSON.stringify(methods.map((methodname, index) => ({ index, methodname, args: {} }))),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) return { alive: false, remainingSeconds: null };
    if (!response.ok) return { alive: null, remainingSeconds: null };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { alive: false, remainingSeconds: null };
    }
    if (!Array.isArray(body) || body.length === 0) return { alive: null, remainingSeconds: null };
    const first = isRecord(body[0]) ? body[0] : undefined;
    if (first?.error) {
      const exception = isRecord(first.exception) ? first.exception : undefined;
      const errorCode = typeof exception?.errorcode === "string" ? exception.errorcode : "";
      if (errorCode === "servicerequireslogin" || errorCode === "sitepolicynotagreed") {
        return { alive: false, remainingSeconds: null };
      }
      return { alive: null, remainingSeconds: null };
    }

    const last = isRecord(body.at(-1)) ? body.at(-1) : undefined;
    const data = isRecord(last?.data) ? last.data : undefined;
    const remainingSeconds = typeof data?.timeremaining === "number" ? data.timeremaining : null;
    const rotatedCookie = cookieFromSetCookie(response.headers.get("set-cookie"), session.cookieName);
    return {
      alive: true,
      remainingSeconds,
      ...(rotatedCookie ? { rotatedCookie } : {}),
    };
  }
}

function firstMatch(value: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = value.match(pattern)?.[1];
    if (match) return match;
  }
  return undefined;
}

function cookieFromSetCookie(header: string | null, cookieName: string): string | undefined {
  if (!header) return undefined;
  const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return header.match(new RegExp(`(?:^|,\\s*)${escaped}=([^;,\\s]+)`))?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
