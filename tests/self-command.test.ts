import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findExecutable, spawnTarget } from "../src/mcp/self-command.js";

describe("findExecutable", () => {
  it("prefers a Windows shim and ignores an extensionless script", async () => {
    const dir = await mkdtemp(join(tmpdir(), "self-command-"));
    try {
      await writeFile(join(dir, "npm"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(join(dir, "npm.cmd"), "@echo off\r\n", { mode: 0o755 });
      // A copied Windows environment spells it "Path".
      expect(findExecutable("npm", { Path: dir }, "win32")).toMatch(/npm\.cmd$/u);
      expect(findExecutable("npm", { PATH: dir }, "linux")).toMatch(/npm$/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnTarget", () => {
  it("leaves executables alone and sends Windows shims through cmd.exe, quoted", () => {
    expect(spawnTarget("/usr/bin/npm", ["install", "a b"], "linux")).toEqual({ command: "/usr/bin/npm", args: ["install", "a b"], shell: false });
    expect(spawnTarget("C:\\nodejs\\node.exe", ["a b"], "win32")).toEqual({ command: "C:\\nodejs\\node.exe", args: ["a b"], shell: false });
    expect(spawnTarget("C:\\Program Files\\nodejs\\npm.cmd", ["install", "--prefix", "C:\\Users\\A B\\npm", "x@1.0.0"], "win32")).toEqual({
      command: '"C:\\Program Files\\nodejs\\npm.cmd"',
      args: ["install", "--prefix", '"C:\\Users\\A B\\npm"', "x@1.0.0"],
      shell: true,
    });
  });

  // Node refuses to spawn a .cmd without a shell, so this only passes when the quoting works.
  it.runIf(process.platform === "win32")("runs a .cmd in a folder with a space, keeping each argument whole", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "self-command-")), "with space");
    try {
      await mkdir(dir);
      const shim = join(dir, "echo-args.cmd");
      await writeFile(shim, "@echo [%~1] [%~2]\r\n");
      const target = spawnTarget(shim, ["a b", "c"]);
      const result = spawnSync(target.command, target.args, { encoding: "utf8", shell: target.shell });
      expect(result.error).toBeUndefined();
      expect(result.stdout.trim()).toBe("[a b] [c]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("runs the npm found on PATH", () => {
    const npm = findExecutable("npm");
    expect(npm).toBeDefined();
    const target = spawnTarget(npm!, ["--version"]);
    const result = spawnSync(target.command, target.args, { encoding: "utf8", shell: target.shell });
    expect(result.error).toBeUndefined();
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
