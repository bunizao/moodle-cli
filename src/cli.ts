import { Command } from "commander";
import {
  commandsJson,
  confirm,
  createProgram,
  insertDefaultVerb,
  render,
  reportError,
  resolveFormat,
  mutating,
  writeOutput,
  type NounSpec,
  type OutputFormat,
} from "@bunizao/cli-kit";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMoodleClient, type MoodleClient } from "./client.js";
import { loadConfig } from "./config.js";
import { MoodleAPIError, UsageError } from "./errors.js";
import {
  formatActivityDetail,
  formatActivityList,
  formatAlerts,
  formatAuthStatus,
  formatCourseSections,
  formatCourses,
  formatForumDiscussion,
  formatForumDiscussionRefs,
  formatForumActivities,
  formatForumSearchHits,
  formatGrades,
  formatKeepaliveResult,
  formatTodo,
  formatUser,
} from "./formatters.js";
import { formatSkillSummary, installSkill, writeGeneratedSkill } from "./skills.js";
import {
  getAuthStatus,
  installKeepalive,
  keepAliveOnce,
  keepaliveStatus,
  uninstallKeepalive,
} from "./keepalive.js";
import { getAuthenticatedSessionWithBrowserFallback, invalidateCachedSession } from "./auth.js";
import { VERSION } from "./version.js";
import { filterDiscussionToPost, parseDiscussionReference, parseForumReference } from "./forum.js";
import { looksLikeUrl, resolveTopLevelUrl } from "./url-resolver.js";

interface CliIO {
  stdout?: NodeJS.WriteStream | { write(chunk: string): boolean };
  stderr?: NodeJS.WriteStream | { write(chunk: string): boolean };
  stdin?: NodeJS.ReadStream;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  rootArgs?: string[];
}

interface Runtime {
  client: MoodleClient | null;
  getClient: () => Promise<MoodleClient>;
  baseUrl: () => Promise<string>;
  output: (data: unknown, formatter: () => string, options: OutputCommandOptions) => Promise<void>;
}

interface OutputCommandOptions {
  json?: boolean;
  yaml?: boolean;
  table?: boolean;
  fields?: string;
  output?: string;
}

const NOUNS: readonly NounSpec[] = [
  { name: "units", aliases: ["courses", "projects"], verbs: ["list", "show"], defaultByArity: { 0: "list", 1: "show" } },
  { name: "activities", verbs: ["list", "show"], defaultByArity: { 1: "list" } },
  { name: "grades", verbs: ["list"], defaultByArity: { 1: "list" } },
  {
    name: "forums",
    verbs: ["list", "show", "search"],
    defaultByArity: { 1: "list" },
    valueFlags: ["--limit", "--course", "--forum", "--limit-forums", "--limit-discussions"],
  },
  { name: "threads", verbs: ["show"], defaultByArity: { 1: "show" }, valueFlags: ["--post"] },
];

export function buildProgram(io: CliIO = {}): Command {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const program = createProgram({ name: "moodle", version: VERSION, description: "Terminal-first CLI for Moodle LMS." });
  program.configureOutput({
    writeOut: (text) => stdout.write(text),
    writeErr: (text) => stderr.write(text),
    outputError: () => undefined,
  });
  program.hook("preAction", (_command, actionCommand) => {
    resolveFormat(actionCommand.optsWithGlobals(), Boolean(stdout && "isTTY" in stdout && stdout.isTTY));
  });
  program.option("--no-cache", "Bypass session cache reads.");
  program.argument("[target]", "Supported Moodle URL");

  const runtime: Runtime = {
    client: null,
    baseUrl: async () => (await loadConfig({ env: io.env, cwd: io.cwd, homeDir: io.homeDir, stdin: io.stdin, stderr: stderr as NodeJS.WritableStream, fetch: io.fetchImpl })).baseUrl,
    getClient: async () => {
      if (!runtime.client) {
        const baseUrl = await runtime.baseUrl();
        runtime.client = await createMoodleClient(baseUrl, {
          env: io.env,
          fetchImpl: io.fetchImpl,
          homeDir: io.homeDir,
          noCache: Boolean(program.opts().cache === false),
        });
      }
      return runtime.client;
    },
    output: async (data, formatter, options) => {
      const merged = { ...program.opts(), ...options } as OutputCommandOptions;
      const format = outputFormat(merged, stdout);
      const text = format === "table"
        ? `${formatter()}\n`
        : render(data, { format, fields: parseFields(data, merged.fields) });
      if (io.stdout && !merged.output) {
        stdout.write(text);
      } else {
        await writeOutput(text, { output: merged.output });
      }
    },
  };

  program.action(async (target: string | undefined, options: Record<string, unknown>, command: Command) => {
    if (!target) {
      command.help();
      return;
    }
    if (!looksLikeUrl(target)) {
      throw new UsageError(`No such command '${target}'.`);
    }
    await dispatchUrl(runtime, target, { ...parseRootOutputOptions(io.rootArgs ?? []), ...options });
  });

  addOutputOptions(program.command("user").description("Show authenticated user info.")).action(async (options: OutputCommandOptions) => {
    const user = await (await runtime.getClient()).getSiteInfo();
    await runtime.output(user, () => formatUser(user), options);
  });

  const units = program.command("units").aliases(["courses", "projects"]).description("Inspect enrolled units.");
  addOutputOptions(units.command("list").description("List enrolled units.")).action(async (options: OutputCommandOptions) => {
    const courses = await (await runtime.getClient()).getCourses();
    await runtime.output(courses, () => formatCourses(courses), options);
  });

  addOutputOptions(units.command("show").description("Show unit detail with sections.").argument("<unit>", "Unit ID or unique name")).action(
    async (unit: string, options: OutputCommandOptions) => {
      const client = await runtime.getClient();
      const courseId = await client.resolveCourseReference(unit);
      const sections = await client.getCourseContents(courseId);
      await runtime.output(sections, () => formatCourseSections(sections), options);
    },
  );

  addOutputOptions(program.command("todo").description("List upcoming actionable timeline items."))
    .option("--limit <number>", "Maximum number of items.", parsePositiveInt, 20)
    .option("--days <number>", "Only include items due within the next N days.", parsePositiveInt)
    .action(async (options: OutputCommandOptions & { limit: number; days?: number }) => {
      const items = await (await runtime.getClient()).getTodo(options.limit, options.days);
      await runtime.output(items, () => formatTodo(items), options);
    });

  addOutputOptions(program.command("alerts").description("List notifications and message counts."))
    .option("--limit <number>", "Maximum number of notifications.", parsePositiveInt, 20)
    .action(async (options: OutputCommandOptions & { limit: number }) => {
      const alerts = await (await runtime.getClient()).getAlerts(options.limit);
      await runtime.output(alerts, () => formatAlerts(alerts), options);
    });

  addOutputOptions(program.command("overview").description("Show a compact multi-source overview."))
    .option("--todo-limit <number>", "Maximum number of todo items.", parsePositiveInt, 5)
    .option("--todo-days <number>", "Only include todo items due within the next N days.", parsePositiveInt)
    .option("--alerts-limit <number>", "Maximum number of notifications.", parsePositiveInt, 5)
    .action(async (options: OutputCommandOptions & { todoLimit: number; todoDays?: number; alertsLimit: number }) => {
      const overview = await (await runtime.getClient()).getOverview(options.todoLimit, options.todoDays, options.alertsLimit);
      await runtime.output(overview, () => `${formatUser(overview.user)}\n\n${formatTodo(overview.todo)}\n\n${overview.alerts ? formatAlerts(overview.alerts) : ""}`, options);
    });

  const activities = program.command("activities").description("Inspect activities.");
  addOutputOptions(activities.command("list").description("List activities in a unit.").argument("<unit>", "Unit ID or unique name")).action(
    async (unit: string, options: OutputCommandOptions) => {
      const client = await runtime.getClient();
      const courseId = await client.resolveCourseReference(unit);
      const items = await client.getActivities(courseId);
      await runtime.output(items, () => formatActivityList(items), options);
    },
  );
  addOutputOptions(activities.command("show").description("Show activity detail.").argument("<id>", "Course-module ID")).action(
    async (id: string, options: OutputCommandOptions) => {
      const item = await (await runtime.getClient()).getActivity(parsePositiveInt(id));
      await runtime.output(item, () => formatActivityDetail(item), options);
    },
  );

  const grades = program.command("grades").description("Inspect grades.");
  addOutputOptions(grades.command("list").description("Show grade details for a unit.").argument("<unit>", "Unit ID or unique name")).action(
    async (unit: string, options: OutputCommandOptions) => {
      const client = await runtime.getClient();
      const courseId = await client.resolveCourseReference(unit);
      const result = await client.getCourseGrades(courseId);
      await runtime.output(result, () => formatGrades(result), options);
    },
  );

  const threads = program.command("threads").description("Inspect forum discussion threads.");
  addOutputOptions(threads.command("show").description("Show posts in a forum discussion.").argument("<discussion>", "Discussion ID or URL"))
    .option("--post <id>", "Show a specific post ID.", parsePositiveInt)
    .option("--body", "Show full post body.")
    .action(async (discussion: string, options: OutputCommandOptions & { post?: number; body?: boolean }) => {
      const parsed = parseDiscussionReference(discussion);
      const postId = options.post ?? parsed.postId;
      const thread = filterDiscussionToPost(await (await runtime.getClient()).getForumDiscussion(parsed.discussionId), postId);
      await runtime.output(thread, () => formatForumDiscussion(thread, { showBody: options.body }), options);
    });

  const forums = program.command("forums").description("Inspect forums.");
  addOutputOptions(forums.command("show").description("List discussions from a forum.").argument("<forum>", "Forum ID or URL"))
    .option("--limit <number>", "Maximum number of discussions.", parsePositiveInt, 50)
    .option("--query <query>", "Filter discussion titles by query.")
    .action(async (forumRef: string, options: OutputCommandOptions & { limit: number; query?: string }) => {
      const client = await runtime.getClient();
      const forumId = await parseForumReference(forumRef, (discussionId) => client.getForumViewCmid(discussionId));
      let refs = await client.getForumDiscussionRefs(forumId);
      if (options.query) {
        refs = refs.filter((ref) => queryMatches(ref.subject, options.query!));
      }
      refs = refs.slice(0, options.limit);
      await runtime.output(refs, () => formatForumDiscussionRefs(forumId, refs), options);
    });

  addOutputOptions(forums.command("list").description("List forum activities in a unit.").argument("<unit>", "Unit ID or unique name"))
    .option("--limit <number>", "Maximum number of forums.", parsePositiveInt, 50)
    .action(async (unit: string, options: OutputCommandOptions & { limit: number }) => {
      const client = await runtime.getClient();
      const courseId = await client.resolveCourseReference(unit);
      let forums = await client.getForums(courseId);
      forums = forums.slice(0, options.limit);
      await runtime.output(forums, () => formatForumActivities(forums), options);
    });

  addForumSearchCommand(forums.command("search").description("Search forum discussion titles and post text."), runtime, 20);

  const auth = program.command("auth").description("Session and keepalive utilities.");

  addOutputOptions(auth.command("status").description("Show cached session freshness and keepalive state.")).action(
    async (options: OutputCommandOptions) => {
      const baseUrl = await runtime.baseUrl();
      const status = await getAuthStatus(baseUrl, { homeDir: io.homeDir, fetchImpl: io.fetchImpl });
      await runtime.output(status, () => formatAuthStatus(status), options);
    },
  );

  addOutputOptions(auth.command("login").description("Extract a fresh session, opening the browser when needed.")).action(
    async (options: OutputCommandOptions) => {
      const baseUrl = await runtime.baseUrl();
      await invalidateCachedSession(baseUrl, { homeDir: io.homeDir });
      const humanOutput = outputFormat(options, stdout) === "table";
      const session = await getAuthenticatedSessionWithBrowserFallback(baseUrl, {
        env: io.env,
        fetch: io.fetchImpl,
        homeDir: io.homeDir,
        onBrowserOpened: humanOutput
          ? (url) => stderr.write(`No active Moodle session found. Complete login in your browser:\n${url}\n`)
          : undefined,
      });
      const result = { base_url: baseUrl, userid: session.userid, cookie_source: session.cookie.source ?? "unknown" };
      await runtime.output(result, () => `Authenticated as userid ${result.userid} via ${result.cookie_source}`, options);
    },
  );

  const keepalive = addOutputOptions(
    auth
      .command("keepalive")
      .description("Renew the Moodle session once; used by the background keepalive agent.")
      .option("--no-renew", "Only touch the session; skip re-login when it is expired."),
  ).action(async (options: OutputCommandOptions & { renew: boolean }) => {
    const baseUrl = await runtime.baseUrl();
    const result = await keepAliveOnce(baseUrl, { homeDir: io.homeDir, fetchImpl: io.fetchImpl, renewOnExpiry: options.renew });
    await runtime.output(result, () => formatKeepaliveResult(result), options);
  });

  addOutputOptions(
    mutating(keepalive
      .command("install")
      .description("Install a macOS launch agent that renews the session periodically.")
      .option("--interval <minutes>", "Renewal interval in minutes.", parsePositiveInt)),
  ).action(async (options: OutputCommandOptions & { interval?: number }) => {
    const globals = program.opts();
    if (!await confirm(
      { summary: `Install the Moodle session keepalive agent${options.interval ? ` with a ${options.interval}-minute interval` : ""}.` },
      { yes: Boolean(globals.yes), dryRun: Boolean(globals.dryRun), interactive: Boolean(io.stdin?.isTTY ?? process.stdin.isTTY) },
    )) return;
    await runtime.baseUrl();
    const result = await installKeepalive({ homeDir: io.homeDir, intervalMinutes: options.interval });
    await runtime.output(result, () => `Keepalive installed: renews every ${result.interval_minutes} min\nAgent: ${result.plist_path}\nLog: ${result.log_path}`, options);
  });

  addOutputOptions(mutating(keepalive.command("uninstall").description("Remove the keepalive launch agent."))).action(
    async (options: OutputCommandOptions) => {
      const globals = program.opts();
      if (!await confirm(
        { summary: "Remove the Moodle session keepalive agent." },
        { yes: Boolean(globals.yes), dryRun: Boolean(globals.dryRun), interactive: Boolean(io.stdin?.isTTY ?? process.stdin.isTTY) },
      )) return;
      const result = await uninstallKeepalive({ homeDir: io.homeDir });
      await runtime.output(result, () => `Keepalive removed (${result.plist_path})`, options);
    },
  );

  addOutputOptions(keepalive.command("status").description("Show whether the keepalive launch agent is installed.")).action(
    async (options: OutputCommandOptions) => {
      const result = await keepaliveStatus(io.homeDir);
      await runtime.output(result, () => (result.installed ? `Keepalive installed (${result.plist_path})` : "Keepalive not installed"), options);
    },
  );

  addOutputOptions(program.command("commands").description("Describe the complete command tree.")).action(
    async (options: OutputCommandOptions) => {
      const description = commandsJson(program);
      await runtime.output(description, () => JSON.stringify(description, null, 2), options);
    },
  );

  const skills = program.command("skills").description("Show skill metadata or delegate to the shared skills CLI.");
  skills.action(() => {
    stdout.write(`${formatSkillSummary()}\n`);
  });
  skills.command("generate").description("Regenerate the agent skill bundle from the CLI command tree.").action(() => {
    writeGeneratedSkill(program);
    stdout.write("Generated Moodle skill bundle\n");
  });
  skills.command("add").description("Install the published skill through npx skills add.").allowUnknownOption(true).action((_options, command) => installSkill(command.args));

  return program;
}

export async function runCli(argv = process.argv, io: CliIO = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  const stdout = io.stdout ?? process.stdout;
  const args = insertDefaultVerb(argv.slice(2), NOUNS);
  const program = buildProgram({ ...io, rootArgs: args });
  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (isCommanderCompletion(error)) {
      return 0;
    }
    const format = errorOutputFormat(args, stdout);
    const reported = reportError(error, format);
    stderr.write(reported.text);
    return reported.exitCode;
  }
}

async function dispatchUrl(runtime: Runtime, target: string, options: OutputCommandOptions): Promise<void> {
  const client = await runtime.getClient();
  const resolved = await resolveTopLevelUrl(client.baseUrl, target, (url) => client.resolveCourseIdForUrl(url));
  const [first] = resolved.args ?? [];
  if (!first) {
    throw new UsageError("Unsupported Moodle URL.");
  }
  switch (resolved.commandName) {
    case "assign": {
      const item = await client.getAssignment(Number(first));
      await runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "quiz": {
      const item = await client.getQuiz(Number(first));
      await runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "resource": {
      const item = await client.getResource(Number(first));
      await runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "link": {
      const item = await client.getLink(Number(first));
      await runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "page": {
      const item = await client.getPage(Number(first));
      await runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "folder": {
      const item = await client.getFolder(Number(first));
      await runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "course": {
      const sections = await client.getCourseContents(Number(first));
      await runtime.output(sections, () => formatCourseSections(sections), options);
      return;
    }
    case "grades": {
      const grades = await client.getCourseGrades(Number(first));
      await runtime.output(grades, () => formatGrades(grades), options);
      return;
    }
    case "forum:discussion": {
      const postHash = resolved.args?.[1] ?? "";
      const postId = postHash.startsWith("#p") ? Number(postHash.slice(2)) : null;
      const discussion = filterDiscussionToPost(await client.getForumDiscussion(Number(first)), Number.isFinite(postId) ? postId : null);
      await runtime.output(discussion, () => formatForumDiscussion(discussion), options);
      return;
    }
    case "forum:discussions": {
      const refs = await client.getForumDiscussionRefs(Number(first));
      await runtime.output(refs, () => formatForumDiscussionRefs(Number(first), refs), options);
      return;
    }
    default:
      throw new UsageError("Unsupported Moodle URL.");
  }
}

function addForumSearchCommand(command: Command, runtime: Runtime, defaultLimit: number): void {
  addOutputOptions(command.argument("<query>", "Search query"))
    .option("--course <course>", "Restrict to a course ID or unique course name match.")
    .option("--forum <forum>", "Restrict to a forum ID or forum URL.")
    .option("--titles-only", "Only search discussion titles.")
    .option("--unread-only", "Only include unread matches.")
    .option("--recent", "Sort matches by newest activity.")
    .option("--limit-forums <number>", "Maximum number of forums to scan.", parsePositiveInt)
    .option("--limit-discussions <number>", "Maximum number of discussions per forum.", parsePositiveInt)
    .option("--limit <number>", "Maximum number of matches.", parsePositiveInt, defaultLimit)
    .action(async (query: string, options: OutputCommandOptions & { course?: string; forum?: string; titlesOnly?: boolean; unreadOnly?: boolean; recent?: boolean; limitForums?: number; limitDiscussions?: number; limit: number }) => {
      const client = await runtime.getClient();
      const courseId = options.course ? await client.resolveCourseReference(options.course) : undefined;
      const forumCmid = options.forum
        ? await parseForumReference(options.forum, (discussionId) => client.getForumViewCmid(discussionId))
        : undefined;
      const hits = await client.searchForumContent({
        query,
        limit: options.limit,
        courseId,
        forumCmid,
        includePostText: !options.titlesOnly,
        unreadOnly: options.unreadOnly,
        sortBy: options.recent ? "recent" : "relevance",
        maxForums: options.limitForums,
        maxDiscussionsPerForum: options.limitDiscussions,
      });
      await runtime.output(hits, () => formatForumSearchHits(hits), options);
    });
}

function addOutputOptions(command: Command): Command {
  return command
    .option("--json", "Output as JSON.")
    .option("--yaml", "Output as YAML.")
    .option("--table", "Force human output.")
    .option("--fields <fields>", "Keep only listed top-level fields in structured output.");
}

function outputFormat(options: OutputCommandOptions, stdout: CliIO["stdout"]): OutputFormat {
  return resolveFormat(options, Boolean(stdout && "isTTY" in stdout && stdout.isTTY));
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError("Expected a positive integer.");
  }
  return parsed;
}

function errorOutputFormat(args: string[], stdout: CliIO["stdout"]): OutputFormat {
  try {
    return resolveFormat(parseRootOutputOptions(args), Boolean(stdout && "isTTY" in stdout && stdout.isTTY));
  } catch {
    return "json";
  }
}

function parseFields(data: unknown, value?: string): string[] | undefined {
  const fields = value?.split(",").map((field) => field.trim()).filter(Boolean);
  if (value !== undefined && !fields?.length) {
    throw new UsageError("--fields must include at least one field.");
  }
  if (fields?.length) {
    const values = Array.isArray(data) ? data : [data];
    const sample = values.find((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown> | undefined;
    if (!sample) {
      throw new UsageError("--fields can only be used with object or object-array output.");
    }
    const valid = Object.keys(sample);
    const invalid = fields.find((field) => !valid.includes(field));
    if (invalid) {
      throw new UsageError(`Unknown field '${invalid}'. Valid fields: ${valid.join(", ")}`);
    }
  }
  return fields;
}

function isCommanderCompletion(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("exitCode" in error && error.exitCode === 0) return true;
  const code = "code" in error ? String(error.code) : "";
  return code.startsWith("commander.help") || code === "commander.version";
}

function parseRootOutputOptions(args: string[]): OutputCommandOptions {
  const fieldsIndex = args.findIndex((arg) => arg === "--fields" || arg.startsWith("--fields="));
  const fieldsArg = fieldsIndex >= 0 ? args[fieldsIndex] : "";
  const fields = fieldsArg.startsWith("--fields=") ? fieldsArg.slice("--fields=".length) : fieldsIndex >= 0 ? args[fieldsIndex + 1] : undefined;
  if (fieldsIndex >= 0 && (!fields || fields.startsWith("--"))) {
    throw new UsageError("--fields requires a value.");
  }
  return {
    json: args.includes("--json"),
    yaml: args.includes("--yaml"),
    table: args.includes("--table"),
    fields,
  };
}

function queryMatches(text: string, query: string): boolean {
  const haystack = text.toLowerCase().split(/\s+/).join(" ");
  const needle = query.toLowerCase().split(/\s+/).join(" ");
  return needle ? haystack.includes(needle) || needle.split(" ").every((token) => haystack.includes(token)) : true;
}

const isMain = process.argv[1] ? realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]) : false;
if (isMain) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
