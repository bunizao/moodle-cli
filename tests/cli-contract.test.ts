import { commandsJson, insertDefaultVerb, VERBS, type CommandDescription, type NounSpec } from "@bunizao/cli-kit";
import { describe, expect, it } from "vitest";

import { buildProgram, runCli } from "../src/cli.js";

const NOUNS: readonly NounSpec[] = [
  { name: "units", aliases: ["courses", "projects"], verbs: ["list", "show"], defaultByArity: { 0: "list", 1: "show" } },
];

describe("shared CLI contract", () => {
  it.each([["--help"], ["-h"], ["-V"], ["help", "units"]])("supports %s", async (...args: string[]) => {
    const stdout = buffer(true);
    const stderr = buffer(false);
    await expect(runCli(["node", "moodle", ...args], { stdout, stderr })).resolves.toBe(0);
    expect(stdout.text()).not.toBe("");
    expect(stderr.text()).toBe("");
  });

  it("returns one structured usage error for an unknown command", async () => {
    const stdout = buffer(false);
    const stderr = buffer(false);
    await expect(runCli(["node", "moodle", "bogus"], { stdout, stderr })).resolves.toBe(2);
    expect(stdout.text()).toBe("");
    expect(JSON.parse(stderr.text())).toMatchObject({ ok: false, error: { code: "usage" }, exit_code: 2 });
  });

  it("describes the full tree and only registers approved verbs", async () => {
    const tree = commandsJson(buildProgram({ stdout: buffer(false), stderr: buffer(false) }));
    const commands = flatten(tree.commands);

    expect(commands.find((command) => command.name === "units")).toMatchObject({ aliases: ["courses", "projects"] });
    expect(commands.every((command) => typeof command.mutating === "boolean")).toBe(true);
    expect(commands.filter((command) => command.verb).every((command) => VERBS.includes(command.verb as never))).toBe(true);

    const stdout = buffer(false);
    await expect(runCli(["node", "moodle", "commands", "--json"], { stdout, stderr: buffer(false) })).resolves.toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({ name: "moodle", commands: expect.any(Array) });
  });

  it("normalizes all enrolment nouns to units", () => {
    expect(insertDefaultVerb(["units"], NOUNS)).toEqual(["units", "list"]);
    expect(insertDefaultVerb(["courses", "FIT1045"], NOUNS)).toEqual(["units", "show", "FIT1045"]);
    expect(insertDefaultVerb(["projects", "show", "FIT1045"], NOUNS)).toEqual(["units", "show", "FIT1045"]);
  });

  it.each([
    ["auth", "keepalive", "install"],
    ["auth", "keepalive", "uninstall"],
  ])("requires --yes for non-interactive mutation %s %s %s", async (...args: string[]) => {
    const stderr = buffer(false);
    await expect(runCli(["node", "moodle", ...args, "--json"], {
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: buffer(false),
      stderr,
    })).resolves.toBe(2);
    expect(JSON.parse(stderr.text())).toMatchObject({ error: { code: "usage" }, exit_code: 2 });
  });
});

function flatten(commands: readonly CommandDescription[]): CommandDescription[] {
  return commands.flatMap((command) => [command, ...flatten(command.commands)]);
}

function buffer(isTTY: boolean) {
  let value = "";
  return {
    isTTY,
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text() {
      return value;
    },
  };
}
