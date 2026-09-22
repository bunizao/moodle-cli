import { describe, expect, it, vi } from "vitest";
import { compareVersions, fetchLatestVersion, isNewerVersion, LATEST_VERSION_URL, updateHint } from "../src/update-core.js";

describe("update-core", () => {
  it("orders releases numerically and ranks prereleases below their release", () => {
    expect(compareVersions("0.10.0", "0.9.2")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  it("treats only well-formed newer versions as an update", () => {
    expect(isNewerVersion("0.9.3", "0.9.2")).toBe(true);
    expect(isNewerVersion("0.9.2", "0.9.2")).toBe(false);
    expect(isNewerVersion("0.9.1", "0.9.2")).toBe(false);
    expect(isNewerVersion(undefined, "0.9.2")).toBe(false);
    expect(isNewerVersion("latest", "0.9.2")).toBe(false);
  });

  it("reads the dist-tags document and swallows every failure", async () => {
    const ok = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe(LATEST_VERSION_URL);
      return Response.json({ latest: "1.2.3" });
    });
    expect(await fetchLatestVersion(ok)).toBe("1.2.3");
    expect(await fetchLatestVersion(async () => new Response("nope", { status: 500 }))).toBeNull();
    expect(await fetchLatestVersion(async () => Response.json({}))).toBeNull();
    expect(await fetchLatestVersion(async () => { throw new Error("offline"); })).toBeNull();
  });

  it("names the command in the hint", () => {
    expect(updateHint("0.9.2", "0.9.3")).toBe("moodle-cli 0.9.3 is available (running 0.9.2). Run: moodle update");
  });
});
