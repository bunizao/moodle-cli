import { insertDefaultVerb, VERBS, type CommandDescription, type NounSpec } from "@bunizao/cli-kit";
import { describe, expect, it } from "vitest";

import { buildProgram, runCli } from "../src/cli.js";
import { describeProgram } from "../src/command-contract.js";
import type { McpCommandService } from "../src/mcp/cli.js";

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
    const tree = describeProgram(buildProgram({ stdout: buffer(false), stderr: buffer(false) }));
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

  it("exposes the managed MCP command contract", () => {
    const tree = describeProgram(buildProgram({ stdout: buffer(false), stderr: buffer(false) }));
    const mcp = tree.commands.find((command) => command.name === "mcp");

    expect(mcp?.commands.map((command) => command.name)).toEqual([
      "deploy",
      "status",
      "login",
      "connect",
      "clients",
      "revoke",
      "pair",
      "remove",
      "serve",
      "bridge",
      "renewal",
      "session",
    ]);
    const deployFlags = mcp?.commands.find((command) => command.name === "deploy")?.options.map((option) => option.flags) ?? [];
    const statusFlags = mcp?.commands.find((command) => command.name === "status")?.options.map((option) => option.flags) ?? [];
    expect(deployFlags).toEqual(expect.arrayContaining(["--dry-run", "--repair", "--rotate-token", "--rollback"]));
    expect(statusFlags).toEqual(expect.arrayContaining(["--verbose", "--logs"]));
  });

  it.each([
    ["auth", "keepalive", "install"],
    ["auth", "keepalive", "uninstall"],
    ["mcp", "deploy"],
  ])("requires --yes for non-interactive mutation %s %s %s", async (...args: string[]) => {
    const stderr = buffer(false);
    await expect(runCli(["node", "moodle", ...args, "--json"], {
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: buffer(false),
      stderr,
    })).resolves.toBe(2);
    expect(JSON.parse(stderr.text())).toMatchObject({ error: { code: "usage" }, exit_code: 2 });
  });

  it("passes managed deployment flags through the CLI boundary", async () => {
    let received: unknown;
    const stdout = buffer(false);
    const service = mcpService({
      deploy: async (input) => {
        received = input;
        return { data: { status: "planned" }, text: "Deployment planned" };
      },
    });

    await expect(runCli([
      "node",
      "moodle",
      "mcp",
      "deploy",
      "--dry-run",
      "--repair",
      "--rotate-token",
      "--rollback",
      "--yes",
      "--json",
    ], { stdout, stderr: buffer(false), mcpService: service })).resolves.toBe(0);

    expect(received).toEqual({ dryRun: true, repair: true, rotateToken: true, rotateKey: false, rollback: true, yes: true });
    expect(JSON.parse(stdout.text())).toEqual({ status: "planned" });
  });

  it("passes managed status diagnostics through the CLI boundary", async () => {
    let received: unknown;
    const service = mcpService({
      status: async (input) => {
        received = input;
        return { data: { status: "pass" }, text: "Moodle MCP: pass" };
      },
    });

    await expect(runCli([
      "node",
      "moodle",
      "mcp",
      "status",
      "--verbose",
      "--logs",
      "--json",
    ], { stdout: buffer(false), stderr: buffer(false), mcpService: service })).resolves.toBe(0);

    expect(received).toEqual({ verbose: true, logs: true });
  });

  it("includes the pairing code in structured output", async () => {
    const stdout = buffer(false);
    const service = mcpService({
      pair: async () => ({
        data: {
          profile: "lms-example",
          endpoint: "https://moodle-example.workers.dev/mcp",
          code: "ABCD2345",
          expiresAt: "2026-09-04T14:00:00.000Z",
          authorizationServer: "https://moodle-example.workers.dev",
        },
        text: "Pairing code\n  ABCD-2345",
      }),
    });

    await expect(runCli(["node", "moodle", "mcp", "pair", "--json"], {
      stdout,
      stderr: buffer(false),
      mcpService: service,
    })).resolves.toBe(0);

    expect(JSON.parse(stdout.text())).toMatchObject({ code: "ABCD2345" });
  });

  it("rejects unsupported managed MCP connection modes", async () => {
    const stderr = buffer(false);
    await expect(runCli(["node", "moodle", "mcp", "connect", "codex", "--mode", "tunnel", "--json"], {
      stdout: buffer(false),
      stderr,
      mcpService: mcpService(),
    })).resolves.toBe(2);
    expect(JSON.parse(stderr.text())).toMatchObject({ error: { code: "usage" }, exit_code: 2 });
  });
});

function mcpService(overrides: Partial<McpCommandService> = {}): McpCommandService {
  const output = async () => ({ data: {}, text: "ok" });
  return {
    deploy: output,
    status: output,
    login: output,
    connect: output,
    pair: output,
    remove: output,
    serveStdio: async () => undefined,
    bridge: async () => undefined,
    renew: output,
    pushSessionFromStdin: output,
    ...overrides,
  } as McpCommandService;
}

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
