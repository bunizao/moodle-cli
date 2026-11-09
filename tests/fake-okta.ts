import { totp } from "okta-auth-cli";

// A scripted Okta Identity Engine org (example.okta.com) in front of a Moodle
// SAML service provider (lms.example.edu), served through a fake fetch. Enough
// of IDX for okta-auth's signIn: password on the identify form, then a TOTP
// code, then the SAML post. Never a real Okta org.

export const MOODLE = "lms.example.edu";
export const OKTA = "example.okta.com";
export const USERNAME = "student@example.edu";
export const PASSWORD = "correct horse battery staple";
export const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

const IDX = "application/ion+json; okta-version=1.0.0";
const STATE_TOKEN = "02.state";
const APP_PATH = "/app/moodle/exk1/sso/saml";
const ACS_PATH = "/auth/saml2/sp/saml2-acs.php/lms";
const SAML_RESPONSE = "PHNhbWw+";

export interface FakeOktaOptions {
  now: () => number;
  // The second factor Okta asks for. phone_number is one okta-auth can't answer.
  factor?: "google_otp" | "phone_number";
  // Every request fails as if the network were down.
  offline?: boolean;
}

export function fakeOkta(options: FakeOktaOptions) {
  const requests: { method: string; url: URL; cookies: Map<string, string>; body: string }[] = [];
  let devices = 0;
  let sessions = 0;
  let signIns = 0;

  async function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (options.offline) throw new TypeError("fetch failed");
    const request = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      cookies: parseCookies(new Headers(init.headers).get("cookie")),
      body: typeof init.body === "string" || init.body instanceof URLSearchParams ? String(init.body) : "",
    };
    requests.push(request);
    if (request.url.hostname === MOODLE) return moodle(request);
    if (request.url.hostname === OKTA) return okta(request, new Headers(init.headers));
    return new Response("unknown host", { status: 502 });
  }

  function moodle({ method, url, cookies, body }: (typeof requests)[number]): Response {
    if (method === "GET" && (url.pathname === "/login/index.php" || url.pathname === "/my/")) {
      if (cookies.get("MoodleSession")?.startsWith("authed-")) return html("<p>Dashboard</p>");
      return redirect(`https://${OKTA}${APP_PATH}?SAMLRequest=r`, ["MoodleSession=anon; Path=/; Secure; HttpOnly"]);
    }
    if (method === "POST" && url.pathname === ACS_PATH && new URLSearchParams(body).get("SAMLResponse") === SAML_RESPONSE) {
      return redirect(`https://${MOODLE}/my/`, [`MoodleSession=authed-${++signIns}; Path=/; Secure; HttpOnly`]);
    }
    return new Response("not found", { status: 404 });
  }

  async function okta({ method, url, cookies, body }: (typeof requests)[number], headers: Headers): Promise<Response> {
    const set: string[] = [];
    if (!cookies.has("DT")) set.push(`DT=dt-${++devices}; Path=/; Max-Age=157680000; Secure; HttpOnly`);
    if (method === "GET" && url.pathname === APP_PATH) {
      if (cookies.get("sid")?.startsWith("okta-session-")) return html(samlForm(), set);
      return html(`<script>var stateToken = '${STATE_TOKEN}';</script>`, set);
    }
    if (method === "GET" && url.pathname === "/login/token/redirect") {
      return redirect(`https://${OKTA}${APP_PATH}`, [...set, `sid=okta-session-${++sessions}; Path=/; Secure; HttpOnly`]);
    }
    if (method !== "POST" || headers.get("content-type") !== IDX) return new Response("not found", { status: 404 });
    const json = JSON.parse(body) as Record<string, any>;
    if ((json.stateToken ?? json.stateHandle) !== STATE_TOKEN) return idx(401, { messages: errors("idx.session.expired") });
    switch (url.pathname) {
      case "/idp/idx/introspect":
        return idx(200, identifyState());
      case "/idp/idx/identify":
        if (json.identifier !== USERNAME || json.credentials?.passcode !== PASSWORD) {
          return idx(401, { ...identifyState(), messages: errors("incorrectPassword") });
        }
        return idx(200, challengeState(options.factor ?? "google_otp"));
      case "/idp/idx/challenge/answer":
        if (json.credentials?.passcode !== await totp(TOTP_SECRET, options.now())) {
          return idx(400, { ...challengeState("google_otp"), messages: errors("api.authn.otp.invalid") });
        }
        return idx(200, {
          stateHandle: STATE_TOKEN,
          success: { name: "success-redirect", href: `https://${OKTA}/login/token/redirect?stateToken=${STATE_TOKEN}` },
        });
    }
    return new Response("not found", { status: 404 });
  }

  return { fetch, requests };
}

function samlForm(): string {
  return `<html><body><form action="https://${MOODLE}${ACS_PATH}" method="POST">
<input name="SAMLResponse" type="hidden" value="${SAML_RESPONSE}"/></form></body></html>`;
}

const stateHandle = { name: "stateHandle", required: true, value: STATE_TOKEN, visible: false, mutable: false };

function identifyState() {
  return {
    version: "1.0.0",
    stateHandle: STATE_TOKEN,
    remediation: {
      type: "array",
      value: [{
        name: "identify",
        href: `https://${OKTA}/idp/idx/identify`,
        method: "POST",
        value: [
          { name: "identifier", label: "Username", required: true },
          { name: "credentials", type: "object", required: true, form: { value: [{ name: "passcode", secret: true }] } },
          stateHandle,
        ],
      }],
    },
  };
}

function challengeState(factor: "google_otp" | "phone_number") {
  return {
    version: "1.0.0",
    stateHandle: STATE_TOKEN,
    remediation: {
      type: "array",
      value: [{
        name: "challenge-authenticator",
        relatesTo: ["$.currentAuthenticatorEnrollment"],
        href: `https://${OKTA}/idp/idx/challenge/answer`,
        method: "POST",
        value: [
          { name: "credentials", type: "object", required: true, form: { value: [{ name: "passcode", secret: true }] } },
          stateHandle,
        ],
      }],
    },
    currentAuthenticatorEnrollment: { type: "object", value: { type: "app", key: factor, id: `aut-${factor}` } },
  };
}

function errors(key: string) {
  return { type: "array", value: [{ message: `Error ${key}`, i18n: { key }, class: "ERROR" }] };
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of header?.split("; ") ?? []) {
    const equals = pair.indexOf("=");
    if (equals > 0) cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  return cookies;
}

function withCookies(headers: Headers, cookies: string[]): Headers {
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return headers;
}

function html(body: string, cookies: string[] = []): Response {
  return new Response(body, { status: 200, headers: withCookies(new Headers({ "content-type": "text/html" }), cookies) });
}

function redirect(location: string, cookies: string[] = []): Response {
  return new Response(null, { status: 303, headers: withCookies(new Headers({ location }), cookies) });
}

function idx(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": IDX } });
}
