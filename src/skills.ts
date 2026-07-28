import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { commandsJson, type CommandDescription } from "@bunizao/cli-kit";

export const SKILL_NAME = "moodle-cli";
export const SKILL_SOURCE = "https://github.com/bunizao/moodle-cli";
export const SKILLS_SPEC_URL = "https://github.com/vercel-labs/skills";
export const SKILL_DESCRIPTION =
  "Read Moodle data with the `moodle` CLI. Use for authenticated profile, unit discovery, deadlines, alerts, sections, activities, grades, assignment or quiz detail, resources, forum search and discussions, supported Moodle URLs, or authentication diagnostics.";

export interface SkillFlag {
  name: string;
  alias?: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
}

export interface SkillArgument {
  name: string;
  required?: boolean;
  variadic?: boolean;
}

export interface SkillCommand {
  name: string;
  path?: string[];
  description?: string;
  arguments?: SkillArgument[];
  flags?: SkillFlag[];
  children?: SkillCommand[];
}

interface GenerateOptions {
  commands: SkillCommand[];
  template: string;
}

type RunCommand = typeof spawnSync;

const SKILL_BUNDLE_TEMPLATES = [
  ["SKILL.md", "skill.template.md"],
  ["references/setup-and-auth.md", "skill-references/setup-and-auth.md"],
  ["references/profile-and-courses.md", "skill-references/profile-and-courses.md"],
  ["references/deadlines-and-alerts.md", "skill-references/deadlines-and-alerts.md"],
  ["references/coursework-and-grades.md", "skill-references/coursework-and-grades.md"],
  ["references/forums.md", "skill-references/forums.md"],
  ["references/output-and-errors.md", "skill-references/output-and-errors.md"],
  ["references/maintenance.md", "skill-references/maintenance.md"],
  ["references/command-reference.md", "skill-references/command-reference.md"],
  ["agents/openai.yaml", "skill-agents/openai.yaml"],
] as const;

export function formatSkillSummary(): string {
  return [
    `Name: ${SKILL_NAME}`,
    `Description: ${SKILL_DESCRIPTION}`,
    `Source: ${SKILL_SOURCE}`,
    `Spec: ${SKILLS_SPEC_URL}`,
    `Install: npx skills add ${SKILL_SOURCE}`,
    "CLI alias: moodle skills add (falls back to npm exec)",
    "Generate: moodle skills generate (writes SKILL.md, references/, and agents/)",
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

export function extractCommanderCommands(program: Command): SkillCommand[] {
  return commandsJson(program).commands.flatMap((command) => commandDescriptionRows(command));
}

function commandDescriptionRows(command: CommandDescription, parentPath: string[] = []): SkillCommand[] {
  const path = [...parentPath, command.name];
  const row: SkillCommand = {
    name: command.name,
    path,
    description: command.description,
    arguments: command.positionals.map((argument) => ({
      name: argument.name,
      required: argument.required,
      variadic: argument.variadic,
    })),
    flags: command.options.map((option) => {
      const names = option.flags.match(/-{1,2}[\w-]+/g) ?? [];
      const name = names.find((value) => value.startsWith("--")) ?? names[0] ?? option.flags;
      const alias = names.find((value) => value !== name);
      return { name, alias, description: option.description, required: option.required };
    }),
  };
  return [row, ...command.commands.flatMap((child) => commandDescriptionRows(child, path))];
}

export function generateSkillMarkdown(program: Command): string;
export function generateSkillMarkdown(options: GenerateOptions): string;
export function generateSkillMarkdown(input: Command | GenerateOptions): string {
  if (isGenerateOptions(input)) {
    return renderSkillMarkdown(input.commands, input.template);
  }

  const template = readSkillTemplate();
  return renderSkillMarkdown(extractCommanderCommands(input), template);
}

export function writeGeneratedSkill(program: Command, target = "SKILL.md"): void {
  const commands = extractCommanderCommands(program);
  const targetDir = path.dirname(target);
  for (const [relativeTarget, relativeTemplate] of SKILL_BUNDLE_TEMPLATES) {
    const outputPath = relativeTarget === "SKILL.md" ? target : path.join(targetDir, relativeTarget);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    const template = readSkillTemplate(relativeTemplate);
    writeFileSync(outputPath, renderSkillMarkdown(commands, template), "utf8");
  }
}

function renderSkillMarkdown(commands: SkillCommand[], template: string): string {
  const replacements: Record<string, string> = {
    generated_frontmatter: renderFrontmatter(),
    generated_intent_table: renderIntentTable(),
    generated_command_reference: renderCommandReference(commands),
    generated_output_contract: renderOutputContract(),
  };

  let markdown = template;
  for (const [key, value] of Object.entries(replacements)) {
    markdown = markdown.replaceAll(`{{${key}}}`, value.trimEnd());
  }
  return `${markdown.trimEnd()}\n`;
}

function renderFrontmatter(): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    "---",
  ].join("\n");
}

function renderIntentTable(): string {
  return renderMarkdownTable(
    ["User intent", "Command"],
    [
      ["Show my profile or account info", "moodle user --json"],
      ["List my units", "moodle units --json"],
      ["Find nearest deadlines or upcoming actions", "moodle todo --limit 5 --days 14 --json"],
      ["List alerts or unread notifications", "moodle alerts --limit 10 --json"],
      ["Show a compact dashboard", "moodle overview --todo-limit 5 --alerts-limit 5 --json"],
      ["Show activities in a unit", "moodle activities UNIT_ID --json"],
      ["Show activity details", "moodle activities show ACTIVITY_ID --json"],
      ["Show unit sections", "moodle units show UNIT_ID --json"],
      ["Show grades for a unit", "moodle grades UNIT_ID --json"],
      ["Search forums", "moodle forums search QUERY --json"],
      ["Open a forum discussion URL or ID", "moodle threads show DISCUSSION_OR_URL --json"],
      ["Check session freshness or authentication state", "moodle auth status --json"],
      ["Keep the session alive to avoid repeated logins", "moodle auth keepalive install"],
      ["Install this agent skill", "moodle skills add"],
    ],
  );
}

function renderCommandReference(commands: SkillCommand[]): string {
  const rows = flattenCommands(commands)
    .sort((left, right) => commandPath(left).localeCompare(commandPath(right)))
    .map((command) => [
      `moodle ${commandPath(command)}`.trim(),
      command.description ?? "",
      renderArguments(command.arguments ?? []),
      renderFlags(command.flags ?? []),
    ]);

  return renderMarkdownTable(["Command", "Description", "Arguments", "Flags"], rows);
}

function renderOutputContract(): string {
  return [
    "### Output Contract",
    "",
    "- `--json` writes JSON to stdout.",
    "- `--yaml` writes YAML to stdout when supported.",
    "- `--table` forces human-readable table/tree output.",
    "- When stdout is not a TTY, commands default to JSON unless `--table` is set.",
    "- `--fields a,b,c` keeps only listed top-level fields. Arrays apply the field filter to each item.",
    "- Invalid `--fields` values are usage errors and list valid fields.",
    "- Structured errors use `{ok:false,error:{code,message,hint},exit_code}` on stderr.",
    "",
    "Exit codes:",
    "",
    renderMarkdownTable(
      ["Code", "Meaning"],
      [
        ["0", "Success"],
        ["1", "Network, configuration, or unexpected error"],
        ["2", "Usage error"],
        ["3", "Authentication error"],
        ["4", "Requested course, activity, forum, or discussion was not found"],
        ["5", "Moodle rejected a well-formed request"],
      ],
    ),
  ].join("\n");
}

function flattenCommands(commands: SkillCommand[]): SkillCommand[] {
  return commands.flatMap((command) => [command, ...flattenCommands(command.children ?? [])]);
}

function commandPath(command: SkillCommand): string {
  return (command.path?.length ? command.path : [command.name]).join(" ");
}

function renderArguments(args: SkillArgument[]): string {
  return args.map((arg) => {
    const name = arg.variadic ? `${arg.name}...` : arg.name;
    return arg.required ? `<${name}>` : `[${name}]`;
  }).join(" ");
}

function renderFlags(flags: SkillFlag[]): string {
  return flags.map((flag) => {
    const names = [flag.alias, flag.name].filter(Boolean).join(", ");
    const defaultValue = formatDefault(flag.defaultValue);
    const required = flag.required ? "value required" : "";
    const suffix = [defaultValue, required].filter(Boolean).join("; ");
    return suffix ? `${names} (${suffix})` : names;
  }).join("<br>");
}

function formatDefault(value: unknown): string {
  if (value === undefined || value === false) {
    return "";
  }
  return `default: ${Array.isArray(value) ? value.join(",") : String(value)}`;
}

function renderMarkdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function isCommandAvailable(name: string, runCommand: RunCommand): boolean {
  const result = runCommand(name, ["--version"], { stdio: "ignore" }) as SpawnSyncReturns<Buffer>;
  return !result.error && result.status === 0;
}

function isGenerateOptions(value: Command | GenerateOptions): value is GenerateOptions {
  return "template" in value && "commands" in value;
}

function readSkillTemplate(relativePath = "skill.template.md"): string {
  return readFileSync(path.join(process.cwd(), "src", relativePath), "utf8");
}
