import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { describeProgram, intentContracts } from "../src/command-contract.js";
import type { CommandDescription } from "@bunizao/cli-kit";

function flatten(rows: readonly CommandDescription[], prefix = "moodle"): Array<{ path: string; options: string[] }> {
  return rows.flatMap(row => [{ path: `${prefix} ${row.name}`, options: row.options.map(o => o.flags) }, ...flatten(row.commands, `${prefix} ${row.name}`)]);
}
const SKILL = "skills/moodle-cli";

describe("shipped vocabulary and guidance", () => {
  it("lists every intent command in the skill and ships only its three references", async () => {
    const skill = await readFile(join(SKILL, "SKILL.md"), "utf8");
    for (const c of Object.values(intentContracts)) expect(skill).toContain(c.command);
    expect((await readdir(join(SKILL, "references"))).sort()).toEqual(["commands.md", "setup-and-auth.md", "usage.md"]);
  });
  it("checks every documented full command and flag in the remaining references", async () => {
    const tree = describeProgram(buildProgram());
    const commands = flatten(tree.commands);
    const rootOptions = [...buildProgram().options.map(o => o.flags), "--help"];
    const allFlags = [...rootOptions, ...commands.flatMap(c => c.options)].join(" ");
    for (const file of await readdir(join(SKILL, "references"))) {
      const content = await readFile(join(SKILL, "references", file), "utf8");
      for (const match of content.matchAll(/\| (moodle [a-z][a-z -]+) \|/gu)) expect(commands.some(c => c.path === match[1])).toBe(true);
      for (const match of content.matchAll(/(?<![\w/])--[a-z][a-z-]+/gu)) expect(allFlags, `${file}: ${match[0]}`).toContain(match[0]);
    }
  });
  it("contains no institution literals in owned source, generated guidance or public docs", async () => {
    const paths = ["README.md", join(SKILL, "SKILL.md")];
    async function gather(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await gather(join(dir, entry.name));
        else if (/\.(?:ts|md)$/u.test(entry.name)) paths.push(join(dir, entry.name));
      }
    }
    await gather("src"); await gather(join(SKILL, "references")); await gather("docs/plans");
    const institutionLiteral = new RegExp("\\b(?:FI" + "T|AT" + "S)\\d+|mon" + "ash", "iu");
    for (const file of paths) expect(await readFile(file, "utf8"), file).not.toMatch(institutionLiteral);
  });
});
