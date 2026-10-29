import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { agentFiles, writeAgentFiles, type AgentFilesOptions } from "@bunizao/cli-kit";
import type { Command } from "commander";
import { describeProgram } from "./command-contract.js";
import { intents } from "./intent-contract.js";
import { VERSION } from "./version.js";

export const SKILL_NAME = "moodle-cli";
export const SKILL_SOURCE = "https://github.com/bunizao/moodle-cli";
export const SKILLS_SPEC_URL = "https://github.com/vercel-labs/skills";
export const SKILL_DESCRIPTION = "Read Moodle units, deadlines, grades and files; submit coursework, manage messages and forums, and run a private MCP server.";

type RunCommand = typeof spawnSync;

export function formatSkillSummary(): string {
  return [
    `Name: ${SKILL_NAME}`,
    `Description: ${SKILL_DESCRIPTION}`,
    `Source: ${SKILL_SOURCE}`,
    `Spec: ${SKILLS_SPEC_URL}`,
    `Install: npx skills add ${SKILL_SOURCE}`,
    "CLI alias: moodle skills add (falls back to npm exec)",
  ].join("\n");
}

export function buildSkillsAddCommand(extraArgs: string[] = [], launcher: "npx" | "npm" = "npx"): string[] {
  if (launcher === "npx") {
    return ["npx", "skills", "add", SKILL_SOURCE, ...extraArgs];
  }
  return ["npm", "exec", "--yes", "--", "skills", "add", SKILL_SOURCE, ...extraArgs];
}

export function addSkill(extraArgs: string[] = [], options: {
  runCommand?: RunCommand;
  commandExists?: (name: string) => boolean;
} = {}): string[] {
  const runCommand = options.runCommand ?? spawnSync;
  const commandExists = options.commandExists ?? ((name: string) => isCommandAvailable(name, runCommand));
  const command = commandExists("npx")
    ? buildSkillsAddCommand(extraArgs, "npx")
    : commandExists("npm")
      ? buildSkillsAddCommand(extraArgs, "npm")
      : undefined;

  if (!command) {
    throw new Error(`npx or npm is required to install agent skills. Install Node.js, then run npx skills add ${SKILL_SOURCE}.`);
  }

  const [program, ...args] = command;
  const result = runCommand(program, args, { stdio: "inherit" }) as SpawnSyncReturns<Buffer>;
  if (result.error) {
    throw new Error(`Failed to launch ${command.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command.join(" ")} exited with status ${result.status ?? "unknown"}.`);
  }

  return command;
}

export function installSkill(extraArgs: string[] = [], options: Parameters<typeof addSkill>[1] = {}): void {
  addSkill(extraArgs, options);
}

// Hand-written reference pages the skill links to; they ship as references/<name>.
// Like `skills generate`, this reads them from ./src relative to the repository root.
const REFERENCES = ["setup-and-auth.md", "command-reference.md"] as const;

const INTRO = `UNIT is a code/name, id or URL; SECTION is a number/name. Discover with \`moodle courses\`; never guess ids.

Details live in two reference files: [setup, sign-in and the private MCP server](references/setup-and-auth.md), and [downloads, sync, grades options and MCP behaviour](references/command-reference.md).`;

const RULES = [
  "Ambiguity returns `candidates`: refine the reference or pick one; never guess ids.",
  "Lists report `total`: narrow the request or page with `--limit` and `--offset`.",
  "Dry-run submissions first (`moodle submit ... --dry-run`), show the plan, then confirm. `--final` submits for grading and is irreversible.",
  "Never expose cookies, tokens or pairing codes. Never paste a pairing code into a web form.",
  "`--json` forces JSON, `--pretty` indents it and `--yaml` writes YAML. Errors are `{ok:false,error:{code,message,hint},exit_code}` on stderr.",
];

const SETUP = `Sign in with \`moodle doctor\`; when a remote MCP session has expired, run \`moodle mcp login\`. \`moodle mcp serve\` starts the local stdio MCP server; \`moodle mcp deploy\` sets up a private remote one. See [setup](references/setup-and-auth.md).`;

export function skillFiles(program: Command): Record<string, string> {
  const options: AgentFilesOptions = {
    skill: {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      title: "Moodle CLI",
      intro: INTRO,
      intents,
      rules: RULES,
      setup: SETUP,
      program: describeProgram(program),
    },
    version: VERSION,
    repository: SKILL_SOURCE,
    author: { name: "bunizao", url: "https://github.com/bunizao" },
    license: "MIT",
    keywords: ["moodle", "mcp", "university", "deadlines", "grades"],
    mcpServers: { moodle: { command: "npx", args: ["-y", "moodle-cli", "mcp", "serve"] } },
    openai: {
      displayName: "Moodle CLI",
      shortDescription: "Inspect Moodle, retrieve authenticated course files and submit assignment files",
      defaultPrompt: "Use $moodle-cli to inspect my Moodle data, retrieve a file through MCP, or download selected files locally with the narrowest relevant operation.",
    },
  };
  return {
    ...agentFiles(options),
    ...Object.fromEntries(REFERENCES.map((name) => [`references/${name}`, readFileSync(path.join(process.cwd(), "src", "skill-references", name), "utf8")])),
  };
}

/** Write the agent bundle under root. With `check`, write nothing and return the stale paths. */
export function writeGeneratedSkill(program: Command, root = process.cwd(), options: { check?: boolean } = {}): string[] {
  return writeAgentFiles(root, skillFiles(program), options);
}

function isCommandAvailable(name: string, runCommand: RunCommand): boolean {
  const result = runCommand(name, ["--version"], { stdio: "ignore" }) as SpawnSyncReturns<Buffer>;
  return !result.error && result.status === 0;
}
