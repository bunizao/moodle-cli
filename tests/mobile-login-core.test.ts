import { describe, expect, it, vi } from "vitest";
import {
  fetchMobileToken,
  mintSessionFromMobileToken,
  parseLaunchToken,
  readMobilePublicConfig,
} from "../src/mobile-login-core.js";

const BASE_URL = "https://school.example.edu";

function launchTokenValue(siteid: string, wstoken: string, privatetoken?: string): string {
  const parts = privatetoken ? [siteid, wstoken, privatetoken] : [siteid, wstoken];
  return Buffer.from(parts.join(":::"), "utf8").toString("base64");
}

describe("parseLaunchToken", () => {
  it("decodes a token with a private token", () => {
    const location = `moodlecli://token=${encodeURIComponent(launchTokenValue("site", "ws-token", "private"))}`;
    expect(parseLaunchToken(location)).toEqual({ wstoken: "ws-token", privatetoken: "private" });
  });

  it("decodes a token without a private token", () => {
    const location = `moodlecli://token=${launchTokenValue("site", "ws-token")}`;
    expect(parseLaunchToken(location)).toEqual({ wstoken: "ws-token", privatetoken: undefined });
  });

  it("rejects malformed input", () => {
    expect(parseLaunchToken("moodlecli://nope")).toBeNull();
    expect(parseLaunchToken(`moodlecli://token=${Buffer.from("only-one-part").toString("base64")}`)).toBeNull();
  });
});

describe("readMobilePublicConfig", () => {
  it("reports whether the mobile web service is on", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify([{ error: false, data: { enablewebservices: 1, enablemobilewebservice: 1 } }]), {
        status: 200,
      }),
    );
    await expect(readMobilePublicConfig(BASE_URL, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      webserviceEnabled: true,
      mobileServiceEnabled: true,
    });
  });

  it("returns null on a fault", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ error: true }]), { status: 200 }));
    await expect(readMobilePublicConfig(BASE_URL, fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });
});

describe("fetchMobileToken", () => {
  it("reads the token out of the launch redirect", async () => {
    const value = launchTokenValue("site", "ws-token", "private");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 302, headers: { location: `moodlecli://token=${value}` } }),
    );
    const token = await fetchMobileToken(BASE_URL, { name: "MoodleSession", value: "live" }, fetchImpl as unknown as typeof fetch);
    expect(token).toEqual({ wstoken: "ws-token", privatetoken: "private" });
    // The launch request must present a MoodleMobile user agent.
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("user-agent")).toContain("MoodleMobile");
  });

  it("returns null when the site never redirects to the scheme", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>login</html>", { status: 200 }));
    await expect(
      fetchMobileToken(BASE_URL, { name: "MoodleSession", value: "live" }, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });
});

describe("mintSessionFromMobileToken", () => {
  it("trades a token for a fresh session cookie", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/webservice/rest/server.php")) {
        return new Response(JSON.stringify({ key: "login-key", autologinurl: `${BASE_URL}/admin/tool/mobile/autologin.php` }), {
          status: 200,
        });
      }
      if (url.includes("/admin/tool/mobile/autologin.php")) {
        return new Response(null, {
          status: 303,
          headers: { location: `${BASE_URL}/`, "set-cookie": "MoodleSession=minted-cookie; path=/; HttpOnly" },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const result = await mintSessionFromMobileToken(
      BASE_URL,
      42,
      { wstoken: "ws-token", privatetoken: "private" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ cookie: { name: "MoodleSession", value: "minted-cookie", source: "mobile-token" } });
  });

  it("returns null without a private token", async () => {
    const fetchImpl = vi.fn();
    await expect(
      mintSessionFromMobileToken(BASE_URL, 1, { wstoken: "ws-token" }, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null on a REST fault", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ exception: "moodle_exception", errorcode: "autologinkeygenerationlockout" }), {
        status: 200,
      }),
    );
    await expect(
      mintSessionFromMobileToken(BASE_URL, 1, { wstoken: "ws", privatetoken: "p" }, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });

  it("ignores the cleared sentinel cookie", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("server.php")) {
        return new Response(JSON.stringify({ key: "k", autologinurl: `${BASE_URL}/admin/tool/mobile/autologin.php` }), { status: 200 });
      }
      // Moodle clears the old cookie before setting the real one; a broken run
      // that only clears must not be mistaken for a live session.
      return new Response(null, { status: 303, headers: { "set-cookie": "MoodleSession=deleted; path=/" } });
    });
    await expect(
      mintSessionFromMobileToken(BASE_URL, 1, { wstoken: "ws", privatetoken: "p" }, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });
});
