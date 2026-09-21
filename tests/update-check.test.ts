import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_TTL_MS } from "../src/update-core.js";
import { detectInstallKind, readUpdateCache, startupCheckApplies, startupUpdateNotice, updateCachePath, writeUpdateCache } from "../src/update-check.js";
import { VERSION } from "../src/version.js";

const NOW = 1_700_000_000_000;

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "moodle-update-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function stderr() {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => lines.push(chunk) };
}

describe("startupCheckApplies", () => {
  it("skips quiet commands, CI and the opt-out variable", () => {
    expect(startupCheckApplies(["todo"], {})).toBe(true);
    expect(startupCheckApplies(["--json", "units"], {})).toBe(true);
    expect(startupCheckApplies([], {})).toBe(true);
    expect(startupCheckApplies(["mcp", "deploy"], {})).toBe(false);
    expect(startupCheckApplies(["update"], {})).toBe(false);
    expect(startupCheckApplies(["todo"], { CI: "1" })).toBe(false);
    expect(startupCheckApplies(["todo"], { MOODLE_NO_UPDATE_CHECK: "1" })).toBe(false);
  });
});

describe("startupUpdateNotice", () => {
  it("prints a cached newer version once a day and stamps the cache", async () => {
    await writeUpdateCache({ latest: "99.0.0", checked_at: NOW }, homeDir);
    const out = stderr();

    await startupUpdateNotice(["todo"], out, { homeDir, env: {}, now: () => NOW });
    await startupUpdateNotice(["todo"], out, { homeDir, env: {}, now: () => NOW + 1000 });

    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("99.0.0");
    expect(out.lines[0]).toContain(`running ${VERSION}`);
    expect((await readUpdateCache(homeDir)).notified_at).toBe(NOW);

    await startupUpdateNotice(["todo"], out, { homeDir, env: {}, now: () => NOW + UPDATE_CHECK_TTL_MS });
    expect(out.lines).toHaveLength(2);
  });

  it("stays silent when the cache is current or absent", async () => {
    const out = stderr();
    await startupUpdateNotice(["todo"], out, { homeDir, env: { MOODLE_NO_UPDATE_CHECK: "1" }, now: () => NOW });
    await writeUpdateCache({ latest: VERSION, checked_at: NOW }, homeDir);
    await startupUpdateNotice(["todo"], out, { homeDir, env: {}, now: () => NOW });
    expect(out.lines).toEqual([]);
  });

  it("keeps the cache private to the user", async () => {
    await writeUpdateCache({ latest: "1.0.0", checked_at: NOW }, homeDir);
    const file = updateCachePath(homeDir);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ latest: "1.0.0", checked_at: NOW });
    const { stat } = await import("node:fs/promises");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("detectInstallKind", () => {
  it("recognises bun's global store, npm, and standalone builds", () => {
    expect(detectInstallKind(["/usr/bin/node", "/home/u/.bun/install/global/node_modules/moodle-cli/dist/moodle.js"], "/usr/bin/node")).toBe("bun");
    expect(detectInstallKind(["/usr/bin/node", "/usr/local/lib/node_modules/moodle-cli/dist/moodle.js"], "/usr/bin/node")).toBe("npm");
    expect(detectInstallKind(["/opt/moodle"], "/opt/moodle")).toBe("standalone");
  });
});

describe("runUpdate", () => {
  it("installs with the detected package manager and deploys with the new bin", async () => {
    vi.resetModules();
    vi.doMock("../src/mcp/self-command.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/mcp/self-command.js")>()),
      findExecutable: (name: string) => (name === "moodle" ? "/new/bin/moodle" : `/bin/${name}`),
    }));
    const { runUpdate } = await import("../src/update-check.js");
    const calls: string[][] = [];
    const report = await runUpdate({
      homeDir,
      env: {},
      now: () => NOW,
      fetchImpl: async () => Response.json({ latest: "99.0.0" }),
      argv: ["/usr/bin/node", "/usr/local/lib/node_modules/moodle-cli/dist/moodle.js"],
      execPath: "/usr/bin/node",
      workerBehind: false,
      runCommand: (command, args) => { calls.push([command, ...args]); return { status: 0 } as never; },
    });
    vi.doUnmock("../src/mcp/self-command.js");

    expect(report).toMatchObject({ current: VERSION, latest: "99.0.0", install: "npm", updated: true, deployed: true });
    expect(calls).toEqual([["/bin/npm", "install", "-g", "moodle-cli@latest"], ["/new/bin/moodle", "mcp", "deploy"]]);
    expect((await readUpdateCache(homeDir)).latest).toBe("99.0.0");
  });

  it("redeploys a stale Worker even when the package is current", async () => {
    vi.resetModules();
    const { runUpdate } = await import("../src/update-check.js");
    const calls: string[][] = [];
    const report = await runUpdate({
      homeDir,
      env: {},
      fetchImpl: async () => Response.json({ latest: VERSION }),
      argv: ["/usr/bin/node", "/usr/local/lib/node_modules/moodle-cli/dist/moodle.js"],
      execPath: "/usr/bin/node",
      workerBehind: true,
      runCommand: (command, args) => { calls.push([command, ...args]); return { status: 0 } as never; },
    });
    expect(report).toMatchObject({ updated: false, deployed: true });
    expect(calls).toEqual([["/usr/bin/node", "/usr/local/lib/node_modules/moodle-cli/dist/moodle.js", "mcp", "deploy"]]);
  });
});
