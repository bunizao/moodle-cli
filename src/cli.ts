import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMoodleClient, type MoodleClient } from "./client.js";
import { loadConfig } from "./config.js";
import { CliError, ConfigError, MoodleAPIError, UsageError, toCliError } from "./errors.js";
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
  formatForumCheckResults,
  formatGrades,
  formatKeepaliveResult,
  formatTodo,
  formatUser,
} from "./formatters.js";
import { serializeStructured, errorJson, type OutputFormat } from "./output.js";
import { formatSkillSummary, installSkill, writeGeneratedSkill } from "./skills.js";
import { checkForUpdates, applySelfUpdate } from "./update.js";
import {
  getAuthStatus,
  installKeepalive,
  keepAliveOnce,
  keepaliveStatus,
  uninstallKeepalive,
} from "./keepalive.js";
import { getAuthenticatedSessionWithBrowserFallback, invalidateCachedSession } from "./auth.js";
import { VERSION } from "./version.js";
import { ASSIGN_VIEW_PATH, FOLDER_VIEW_PATH, PAGE_VIEW_PATH, QUIZ_VIEW_PATH, RESOURCE_VIEW_PATH, URL_VIEW_PATH } from "./constants.js";
import { filterDiscussionToPost, parseDiscussionReference, parseForumReference } from "./forum.js";
import { checkForumDiscussions } from "./forum-search.js";
import { looksLikeUrl, parseActivityReference, resolveTopLevelUrl } from "./url-resolver.js";

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
  output: (data: unknown, formatter: () => string, options: OutputCommandOptions) => void;
}

interface OutputCommandOptions {
  json?: boolean;
  yaml?: boolean;
  table?: boolean;
  fields?: string;
}

export function buildProgram(io: CliIO = {}): Command {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const program = new Command("moodle");
  program.version(VERSION);
  program.description("Terminal-first CLI for Moodle LMS.");
  program.exitOverride();
  program.allowUnknownOption(true);
  program.allowExcessArguments(true);
  program.configureOutput({
    writeOut: (text) => stdout.write(text),
    writeErr: (text) => stderr.write(text),
  });
  program.option("-v, --verbose", "Enable debug logging.");
  program.option("--no-cache", "Bypass session cache reads.");
  program.argument("[target]", "Supported Moodle URL");

  const runtime: Runtime = {
    client: null,
    baseUrl: async () => (await loadConfig({ env: io.env, cwd: io.cwd, homeDir: io.homeDir, stdin: io.stdin, fetch: io.fetchImpl })).baseUrl,
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
    output: (data, formatter, options) => {
      const format = outputFormat(options, stdout);
      if (format === "table") {
        stdout.write(`${formatter()}\n`);
      } else {
        stdout.write(`${serializeStructured(data, { format, fields: options.fields })}\n`);
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
    runtime.output(user, () => formatUser(user), options);
  });

  addOutputOptions(program.command("courses").description("List enrolled courses.")).action(async (options: OutputCommandOptions) => {
    const courses = await (await runtime.getClient()).getCourses();
    runtime.output(courses, () => formatCourses(courses), options);
  });

  addOutputOptions(program.command("todo").description("List upcoming actionable timeline items."))
    .option("--limit <number>", "Maximum number of items.", parsePositiveInt, 20)
    .option("--days <number>", "Only include items due within the next N days.", parsePositiveInt)
    .action(async (options: OutputCommandOptions & { limit: number; days?: number }) => {
      const items = await (await runtime.getClient()).getTodo(options.limit, options.days);
      runtime.output(items, () => formatTodo(items), options);
    });

  addOutputOptions(program.command("alerts").description("List notifications and message counts."))
    .option("--limit <number>", "Maximum number of notifications.", parsePositiveInt, 20)
    .action(async (options: OutputCommandOptions & { limit: number }) => {
      const alerts = await (await runtime.getClient()).getAlerts(options.limit);
      runtime.output(alerts, () => formatAlerts(alerts), options);
    });

  addOutputOptions(program.command("overview").description("Show a compact multi-source overview."))
    .option("--todo-limit <number>", "Maximum number of todo items.", parsePositiveInt, 5)
    .option("--todo-days <number>", "Only include todo items due within the next N days.", parsePositiveInt)
    .option("--alerts-limit <number>", "Maximum number of notifications.", parsePositiveInt, 5)
    .action(async (options: OutputCommandOptions & { todoLimit: number; todoDays?: number; alertsLimit: number }) => {
      const overview = await (await runtime.getClient()).getOverview(options.todoLimit, options.todoDays, options.alertsLimit);
      runtime.output(overview, () => `${formatUser(overview.user)}\n\n${formatTodo(overview.todo)}\n\n${overview.alerts ? formatAlerts(overview.alerts) : ""}`, options);
    });

  addCourseCommand(program, runtime, "course", "Show course detail with sections.", async (client, courseId) => client.getCourseContents(courseId), formatCourseSections);
  addCourseCommand(program, runtime, "activities", "List activities in a course.", async (client, courseId) => client.getActivities(courseId), formatActivityList);

  addOutputOptions(program.command("grades").description("Show grade details for a course.").argument("<course>", "Course ID or unique name")).action(
    async (course: string, options: OutputCommandOptions) => {
      const client = await runtime.getClient();
      const courseId = await client.resolveCourseReference(course);
      const grades = await client.getCourseGrades(courseId);
      runtime.output(grades, () => formatGrades(grades), options);
    },
  );

  addActivityCommand(program, runtime, "assign", "Assignment", ASSIGN_VIEW_PATH, (client, id) => client.getAssignment(id));
  addActivityCommand(program, runtime, "quiz", "Quiz", QUIZ_VIEW_PATH, (client, id) => client.getQuiz(id));
  addActivityCommand(program, runtime, "resource", "Resource", RESOURCE_VIEW_PATH, (client, id) => client.getResource(id));
  addActivityCommand(program, runtime, "link", "Link", URL_VIEW_PATH, (client, id) => client.getLink(id));
  addActivityCommand(program, runtime, "page", "Page", PAGE_VIEW_PATH, (client, id) => client.getPage(id));
  addActivityCommand(program, runtime, "folder", "Folder", FOLDER_VIEW_PATH, (client, id) => client.getFolder(id));

  const forum = program.command("forum").description("Forum utilities.");
  addOutputOptions(forum.command("discussion").description("Show posts in a forum discussion.").argument("<discussion>", "Discussion ID or URL"))
    .option("--post <id>", "Show a specific post ID.", parsePositiveInt)
    .option("--body", "Show full post body.")
    .action(async (discussion: string, options: OutputCommandOptions & { post?: number; body?: boolean }) => {
      const parsed = parseDiscussionReference(discussion);
      const postId = options.post ?? parsed.postId;
      const thread = filterDiscussionToPost(await (await runtime.getClient()).getForumDiscussion(parsed.discussionId), postId);
      runtime.output(thread, () => formatForumDiscussion(thread, { showBody: options.body }), options);
    });

  addOutputOptions(forum.command("discussions").description("List discussions from a forum.").argument("<forum>", "Forum ID or URL"))
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
      runtime.output(refs, () => formatForumDiscussionRefs(forumId, refs), options);
    });

  addOutputOptions(forum.command("forums").description("List forum activities.").argument("[query]", "Optional forum/course query"))
    .option("--course <course>", "Restrict to a course ID or unique course name match.")
    .option("--limit <number>", "Maximum number of forums.", parsePositiveInt, 50)
    .action(async (query: string | undefined, options: OutputCommandOptions & { course?: string; limit: number }) => {
      const client = await runtime.getClient();
      const courseId = options.course ? await client.resolveCourseReference(options.course) : undefined;
      let forums = await client.getForums(courseId);
      if (query) {
        forums = forums.filter((forum) => queryMatches(forum.name, query) || queryMatches(forum.course_name, query));
      }
      forums = forums.slice(0, options.limit);
      runtime.output(forums, () => formatForumActivities(forums), options);
    });

  addForumSearchCommand(forum.command("search").description("Search forum discussion titles and post text."), runtime, 20, false);
  addForumSearchCommand(forum.command("find").description("Find the best forum match.").option("--list", "Return a shortlist.").option("--body", "Resolve the target body."), runtime, 5, true);

  addOutputOptions(forum.command("check").description("Validate discussion rendering.").argument("<forum>", "Forum ID or URL"))
    .option("--limit <number>", "Maximum number of discussions.", parsePositiveInt, 20)
    .action(async (forumRef: string, options: OutputCommandOptions & { limit: number }) => {
      const client = await runtime.getClient();
      const forumId = await parseForumReference(forumRef, (discussionId) => client.getForumViewCmid(discussionId));
      const results = await checkForumDiscussions(client, forumId, options.limit);
      runtime.output(results, () => formatForumCheckResults(forumId, results), options);
    });

  const auth = program.command("auth").description("Session and keepalive utilities.");

  addOutputOptions(auth.command("status").description("Show cached session freshness and keepalive state.")).action(
    async (options: OutputCommandOptions) => {
      const baseUrl = await runtime.baseUrl();
      const status = await getAuthStatus(baseUrl, { homeDir: io.homeDir, fetchImpl: io.fetchImpl });
      runtime.output(status, () => formatAuthStatus(status), options);
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
      runtime.output(result, () => `Authenticated as userid ${result.userid} via ${result.cookie_source}`, options);
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
    runtime.output(result, () => formatKeepaliveResult(result), options);
  });

  addOutputOptions(
    keepalive
      .command("install")
      .description("Install a macOS launch agent that renews the session periodically.")
      .option("--interval <minutes>", "Renewal interval in minutes.", parsePositiveInt),
  ).action(async (options: OutputCommandOptions & { interval?: number }) => {
    await runtime.baseUrl();
    const result = await installKeepalive({ homeDir: io.homeDir, intervalMinutes: options.interval });
    runtime.output(result, () => `Keepalive installed: renews every ${result.interval_minutes} min\nAgent: ${result.plist_path}\nLog: ${result.log_path}`, options);
  });

  addOutputOptions(keepalive.command("uninstall").description("Remove the keepalive launch agent.")).action(
    async (options: OutputCommandOptions) => {
      const result = await uninstallKeepalive({ homeDir: io.homeDir });
      runtime.output(result, () => `Keepalive removed (${result.plist_path})`, options);
    },
  );

  addOutputOptions(keepalive.command("status").description("Show whether the keepalive launch agent is installed.")).action(
    async (options: OutputCommandOptions) => {
      const result = await keepaliveStatus(io.homeDir);
      runtime.output(result, () => (result.installed ? `Keepalive installed (${result.plist_path})` : "Keepalive not installed"), options);
    },
  );

  addOutputOptions(program.command("update").description("Check for updates and upgrade the installed CLI."))
    .option("--check-only", "Only check for updates; do not install.")
    .action(async (options: OutputCommandOptions & { checkOnly?: boolean }) => {
      try {
        const info = await checkForUpdates(VERSION, io.fetchImpl);
        if (outputFormat(options, stdout) !== "table") {
          runtime.output(info, () => "", options);
          return;
        }
        if (!info.update_available) {
          stdout.write(`${info.package_name} is up to date (${info.current_version})\n`);
          return;
        }
        stdout.write(`Update available: ${info.latest_version} (installed: ${info.current_version})\n`);
        if (options.checkOnly) {
          stdout.write(`Upgrade with: ${info.upgrade_commands.join(" && ")}\n`);
          return;
        }
        stdout.write(`Updated with: ${applySelfUpdate()}\n`);
      } catch (error) {
        stdout.write(`Could not check for updates: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    });

  const skills = program.command("skills").description("Show skill metadata or delegate to the shared skills CLI.");
  skills.action(() => {
    stdout.write(`${formatSkillSummary()}\n`);
  });
  skills.command("generate").description("Regenerate the agent skill bundle from the CLI command tree.").action(() => {
    writeGeneratedSkill(program);
    stdout.write("Generated Moodle skill bundle\n");
  });
  skills.command("add").description("Install the published skill through npx skills add.").allowUnknownOption(true).action((_options, command) => installSkill(command.args));
  hideCommand(skills.command("install").allowUnknownOption(true)).action((_options: unknown, command: Command) => installSkill(command.args));
  hideCommand(skills.command("i").allowUnknownOption(true)).action((_options: unknown, command: Command) => installSkill(command.args));

  return program;
}

export async function runCli(argv = process.argv, io: CliIO = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  const stdout = io.stdout ?? process.stdout;
  const program = buildProgram({ ...io, rootArgs: argv.slice(2) });
  try {
    await program.parseAsync(argv, { from: "node" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      const cliError = new UsageError(error.message);
      writeError(cliError, stderr, wantsJsonFromArgs(argv, stdout));
      return cliError.exitCode;
    }
    const cliError = toCliError(error);
    writeError(cliError, stderr, wantsJsonFromArgs(argv, stdout));
    return cliError.exitCode;
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
      runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "quiz": {
      const item = await client.getQuiz(Number(first));
      runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "resource": {
      const item = await client.getResource(Number(first));
      runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "link": {
      const item = await client.getLink(Number(first));
      runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "page": {
      const item = await client.getPage(Number(first));
      runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "folder": {
      const item = await client.getFolder(Number(first));
      runtime.output(item, () => formatActivityDetail(item), options);
      return;
    }
    case "course": {
      const sections = await client.getCourseContents(Number(first));
      runtime.output(sections, () => formatCourseSections(sections), options);
      return;
    }
    case "grades": {
      const grades = await client.getCourseGrades(Number(first));
      runtime.output(grades, () => formatGrades(grades), options);
      return;
    }
    case "forum:discussion": {
      const postHash = resolved.args?.[1] ?? "";
      const postId = postHash.startsWith("#p") ? Number(postHash.slice(2)) : null;
      const discussion = filterDiscussionToPost(await client.getForumDiscussion(Number(first)), Number.isFinite(postId) ? postId : null);
      runtime.output(discussion, () => formatForumDiscussion(discussion), options);
      return;
    }
    case "forum:discussions": {
      const refs = await client.getForumDiscussionRefs(Number(first));
      runtime.output(refs, () => formatForumDiscussionRefs(Number(first), refs), options);
      return;
    }
    default:
      throw new UsageError("Unsupported Moodle URL.");
  }
}

function addCourseCommand(
  program: Command,
  runtime: Runtime,
  name: string,
  description: string,
  load: (client: MoodleClient, courseId: number) => Promise<unknown>,
  format: (value: never) => string,
): void {
  addOutputOptions(program.command(name).description(description).argument("<course>", "Course ID or unique name")).action(async (course: string, options: OutputCommandOptions) => {
    const client = await runtime.getClient();
    const courseId = await client.resolveCourseReference(course);
    const value = await load(client, courseId);
    runtime.output(value, () => format(value as never), options);
  });
}

function addActivityCommand(
  program: Command,
  runtime: Runtime,
  name: string,
  label: string,
  path: string,
  load: (client: MoodleClient, id: number) => Promise<unknown>,
): Command {
  return addOutputOptions(program.command(name).description(`Show ${label.toLowerCase()} details.`).argument(`<${name}>`, `${label} ID or URL`)).action(
    async (value: string, options: OutputCommandOptions) => {
      const id = parseActivityReference(value, label, path);
      const item = await load(await runtime.getClient(), id);
      runtime.output(item, () => formatActivityDetail(item as never), options);
    },
  );
}

function addForumSearchCommand(command: Command, runtime: Runtime, defaultLimit: number, findMode: boolean): void {
  addOutputOptions(command.argument("<query>", "Search query"))
    .option("--course <course>", "Restrict to a course ID or unique course name match.")
    .option("--forum <forum>", "Restrict to a forum ID or forum URL.")
    .option("--titles-only", "Only search discussion titles.")
    .option("--unread-only", "Only include unread matches.")
    .option("--recent", "Sort matches by newest activity.")
    .option("--limit-forums <number>", "Maximum number of forums to scan.", parsePositiveInt)
    .option("--limit-discussions <number>", "Maximum number of discussions per forum.", parsePositiveInt)
    .option("--limit <number>", "Maximum number of matches.", parsePositiveInt, defaultLimit)
    .action(async (query: string, options: OutputCommandOptions & { course?: string; forum?: string; titlesOnly?: boolean; unreadOnly?: boolean; recent?: boolean; limitForums?: number; limitDiscussions?: number; limit: number; list?: boolean; body?: boolean }) => {
      const client = await runtime.getClient();
      const courseId = options.course ? await client.resolveCourseReference(options.course) : undefined;
      const forumCmid = options.forum
        ? await parseForumReference(options.forum, (discussionId) => client.getForumViewCmid(discussionId))
        : undefined;
      const limit = findMode && !options.list ? 1 : options.limit;
      const hits = await client.searchForumContent({
        query,
        limit,
        courseId,
        forumCmid,
        includePostText: !options.titlesOnly,
        unreadOnly: options.unreadOnly,
        sortBy: options.recent || findMode ? "recent" : "relevance",
        maxForums: options.limitForums,
        maxDiscussionsPerForum: options.limitDiscussions,
      });
      if (findMode && options.body && hits[0]) {
        const discussion = filterDiscussionToPost(await client.getForumDiscussion(hits[0].discussion_id), hits[0].post_id || null);
        runtime.output(discussion, () => formatForumDiscussion(discussion, { showBody: true }), options);
        return;
      }
      const output = findMode && !options.list ? (hits[0] ?? null) : hits;
      runtime.output(output, () => formatForumSearchHits(Array.isArray(output) ? output : output ? [output] : []), options);
    });
}

function addOutputOptions(command: Command): Command {
  return command
    .option("--json", "Output as JSON.")
    .option("--yaml", "Output as YAML.")
    .option("--table", "Force human output.")
    .option("--fields <fields>", "Keep only listed top-level fields in structured output.");
}

function hideCommand(command: Command): Command {
  (command as Command & { hidden?: boolean }).hidden = true;
  return command;
}

function outputFormat(options: OutputCommandOptions, stdout: CliIO["stdout"]): OutputFormat {
  if (options.yaml) {
    return "yaml";
  }
  if (options.json) {
    return "json";
  }
  if (options.table) {
    return "table";
  }
  return "isTTY" in (stdout as NodeJS.WriteStream) && (stdout as NodeJS.WriteStream).isTTY ? "table" : "json";
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError("Expected a positive integer.");
  }
  return parsed;
}

function writeError(error: CliError, stderr: CliIO["stderr"], asJson: boolean): void {
  if (asJson) {
    stderr?.write(`${errorJson(error.code, error.message, error.hint)}\n`);
    return;
  }
  stderr?.write(`${labelFor(error)}: ${error.message}\n`);
  if (error instanceof ConfigError && error.hint) {
    stderr?.write(`${error.hint}\n`);
  } else if (error.hint) {
    stderr?.write(`${error.hint}\n`);
  }
  if (error instanceof MoodleAPIError && error.moodleErrorCode) {
    stderr?.write(`Error code: ${error.moodleErrorCode}\n`);
  }
}

function wantsJsonFromArgs(argv: string[], stdout: CliIO["stdout"]): boolean {
  return argv.includes("--json") || (!argv.includes("--table") && !("isTTY" in (stdout as NodeJS.WriteStream) && (stdout as NodeJS.WriteStream).isTTY));
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

function labelFor(error: CliError): string {
  if (error.code === "auth_failed") {
    return "Auth error";
  }
  if (error.code === "config_error") {
    return "Config error";
  }
  if (error.code === "usage_error") {
    return "Usage error";
  }
  if (error.code === "not_found") {
    return "Not found";
  }
  return "Error";
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
