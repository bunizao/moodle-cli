import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../src/cli.js";
import {
  addSkill,
  buildSkillsAddCommand,
  formatSkillSummary,
  skillFiles,
  writeGeneratedSkill,
} from "../src/skills.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);

beforeEach(() => {
  spawnSyncMock.mockReset();
});

describe("skills install wrappers", () => {
  it("builds the npx skills add command", () => {
    expect(buildSkillsAddCommand(["--agent", "codex"])).toEqual([
      "npx",
      "skills",
      "add",
      "https://github.com/bunizao/moodle-cli",
      "--agent",
      "codex",
    ]);
  });

  it("falls back to npm exec when npx is unavailable", () => {
    expect(buildSkillsAddCommand(["--agent", "codex"], "npm")).toEqual([
      "npm",
      "exec",
      "--yes",
      "--",
      "skills",
      "add",
      "https://github.com/bunizao/moodle-cli",
      "--agent",
      "codex",
    ]);
  });

  it("delegates to npx without making a real subprocess", () => {
    spawnSyncMock.mockReturnValue({ status: 0 } as never);

    const command = addSkill(["--agent", "codex"]);

    expect(command).toEqual([
      "npx",
      "skills",
      "add",
      "https://github.com/bunizao/moodle-cli",
      "--agent",
      "codex",
    ]);
    expect(spawnSyncMock).toHaveBeenCalledWith("npx", ["--version"], { stdio: "ignore" });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "https://github.com/bunizao/moodle-cli", "--agent", "codex"],
      { stdio: "inherit" },
    );
  });
});

describe("skill generation", () => {
  it("summarizes the skill entrypoint", () => {
    expect(formatSkillSummary()).toContain("Install: npx skills add https://github.com/bunizao/moodle-cli");
    expect(formatSkillSummary()).toContain("Moodle units");
  });

  it("builds every agent file from the command tree and the intents", () => {
    const files = skillFiles(buildProgram());

    expect(Object.keys(files).sort()).toEqual([
      ".claude-plugin/marketplace.json",
      ".claude-plugin/plugin.json",
      "SKILL.md",
      "agents/openai.yaml",
      "references/command-reference.md",
      "references/setup-and-auth.md",
    ]);
    expect(files["SKILL.md"]).toContain("`--final` submits for grading and is irreversible");
    expect(files["SKILL.md"]).toContain("Never expose cookies, tokens or pairing codes");
    expect(files["SKILL.md"]).toContain("references/setup-and-auth.md");
    expect(files["SKILL.md"]).toContain("`moodle courses`");
    expect(files["agents/openai.yaml"]).toContain("display_name: Moodle CLI");
    expect(JSON.parse(files[".claude-plugin/plugin.json"])).toMatchObject({
      name: "moodle-cli",
      skills: "./",
      mcpServers: { moodle: { command: "npx", args: ["-y", "moodle-cli", "mcp", "serve"] } },
    });
  });

  it("reports stale files in check mode and writes them otherwise", async () => {
    const root = await mkdtemp(join(tmpdir(), "moodle-skill-"));
    const program = buildProgram();
    const all = Object.keys(skillFiles(program)).sort();

    expect(writeGeneratedSkill(program, root, { check: true }).sort()).toEqual(all);
    await expect(readFile(join(root, "SKILL.md"), "utf8")).rejects.toThrow();
    expect(writeGeneratedSkill(program, root).sort()).toEqual(all);
    expect(writeGeneratedSkill(program, root, { check: true })).toEqual([]);
  });

  it("matches the committed skill bundle", () => {
    // Fails when a command, intent, version or reference changed without `npm run skill:generate`.
    expect(writeGeneratedSkill(buildProgram(), process.cwd(), { check: true })).toEqual([]);
  });
});
