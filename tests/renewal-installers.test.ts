import { describe, expect, it, vi } from "vitest";
import {
  RenewalInstaller,
  buildRenewalInstallPlan,
  type RenewalInstallerIO,
  type RenewalPlatform,
} from "../src/mcp/renewal/index.js";

describe.each([
  ["darwin", "launchctl", "LaunchAgents", "StartInterval"],
  ["linux", "systemctl", "systemd/user", "OnUnitActiveSec=30m"],
  ["win32", "schtasks.exe", "AppData\\Local", "PT30M"],
] as const)("%s renewal installer", (platform, command, pathFragment, contentFragment) => {
  it("builds a private, profile-scoped background job", () => {
    const plan = buildRenewalInstallPlan({
      platform: platform as RenewalPlatform,
      profile: "school",
      executable: platform === "win32" ? "C:\\Program Files\\moodle.exe" : "/usr/local/bin/moodle",
      homeDirectory: platform === "win32" ? "C:\\Users\\Alice" : "/Users/alice",
      uid: 501,
    });
    expect(plan.files.every((file) => file.mode === 0o600)).toBe(true);
    expect(plan.files.some((file) => file.path.includes(pathFragment))).toBe(true);
    expect(plan.files.map((file) => file.content).join("\n")).toContain(contentFragment);
    expect(plan.files.map((file) => file.content).join("\n")).toContain("mcp");
    expect(plan.files.map((file) => file.content).join("\n")).toContain("renewal");
    expect(plan.installCommands.some((item) => item.command === command)).toBe(true);
  });
});

describe("RenewalInstaller", () => {
  it("writes descriptors before activation and scopes removal to its own files and task", async () => {
    const calls: string[] = [];
    const io: RenewalInstallerIO = {
      writePrivate: vi.fn(async (path) => { calls.push(`write:${path}`); }),
      removeFile: vi.fn(async (path) => { calls.push(`remove:${path}`); }),
      exists: vi.fn(async () => true),
      run: vi.fn(async (command, args) => { calls.push(`run:${command}:${args.join(" ")}`); }),
    };
    const plan = buildRenewalInstallPlan({
      platform: "linux",
      profile: "school",
      executable: "/usr/bin/moodle",
      homeDirectory: "/home/alice",
    });
    const installer = new RenewalInstaller(plan, io);

    await installer.install();
    expect(calls[0]).toContain("write:/home/alice/.config/systemd/user/moodle-cli-mcp-renewal-school.service");
    expect(calls.findIndex((call) => call.startsWith("run:"))).toBeGreaterThan(1);
    await expect(installer.inspect()).resolves.toBe(true);

    calls.length = 0;
    await installer.remove();
    expect(calls[0]).toContain("disable --now moodle-cli-mcp-renewal-school.timer");
    expect(calls.filter((call) => call.startsWith("remove:"))).toHaveLength(2);
    expect(calls.at(-1)).toContain("daemon-reload");
    expect(calls.join("\n")).not.toContain("another-profile");
  });

  it("rejects command or profile injection", () => {
    expect(() => buildRenewalInstallPlan({
      platform: "linux",
      profile: "school;shutdown",
      executable: "/usr/bin/moodle",
      homeDirectory: "/home/alice",
    })).toThrow("Invalid renewal profile");
    expect(() => buildRenewalInstallPlan({
      platform: "darwin",
      profile: "school",
      executable: "/usr/bin/moodle\nmalicious",
      homeDirectory: "/Users/alice",
    })).toThrow("Invalid renewal executable");
  });
});
