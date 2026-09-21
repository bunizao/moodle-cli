import { activitySchema } from "./intent-contract.js";
import { activityRow, itemRow, postRow, stripEmpty } from "./results.js";
import { doctor, ownedJobs } from "./doctor.js";
import { readFile, rm, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { DefaultRenewalIntegration } from "./mcp/renewal/index.js";
import { CACHE_DIR_NAME, CONFIG_DIR_NAME, MOODLE_SESSION_COOKIE_PREFIX } from "./constants.js";
import { runtimeSupportsCookies } from "./mcp/self-command.js";
import { createMoodleGateway } from "./mcp/gateway.js";
import { createIntentService, type IntentService } from "./intents.js";
import { humanDescription, type Intent } from "./intent-contract.js";
import { ReferenceError, normalize, resolveSection, splitUnitPhrase, type Candidate } from "./resolve.js";
import { renderScreen, tryLines } from "./screens.js";
import type { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { Command } from "commander";
import {
  banner,
  colorEnabled,
  confirm,
  createProgram,
  createTheme,
  createUi,
  detectAudience,
  examples,
  helpSection,
  insertDefaultVerb,
  isInformationalExit,
  parseWithPrompts,
  render,
  reportError,
  normalizeError,
  resolveFormat,
  mutating,
  writeOutput,
  type ArgumentFiller,
  type NounSpec,
  type OutputFormat,
  type Theme,
  type Ui,
} from "@bunizao/cli-kit";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMoodleClient, type MoodleClient } from "./client.js";
import { refreshLatestVersion, runUpdate, startupUpdateNotice } from "./update-check.js";
import { isNewerVersion } from "./update-core.js";
import { loadConfig } from "./config.js";
import { AuthError, CliError, MoodleAPIError, UsageError, asNetworkError } from "./errors.js";
import {
  formatActivityDetail,
  formatActivityList,
  formatAlerts,
  formatAuthStatus,
  formatCourseSections,
  formatCourses,
  formatAttemptFinish,
  formatAttemptPage,
  formatAttemptSummary,
  formatDownloadReceipt,
  formatForumDiscussion,
  formatSubmissionReceipt,
  formatForumDiscussionRefs,
  formatForumActivities,
  formatForumSearchHits,
  formatGrades,
  formatKeepaliveResult,
  formatTodo,
  formatUser,
} from "./formatters.js";
import { downloadMoodleFile } from "./download.js";
import type { SubmissionReceipt } from "./moodle-assign-core.js";
import type { AttemptPage } from "./moodle-quiz-core.js";
import { resolveSubmissionPath } from "./submit.js";
import { formatSkillSummary, installSkill, writeGeneratedSkill } from "./skills.js";
import {
  getAuthStatus,
  installKeepalive,
  keepAliveOnce,
  keepaliveStatus,
  uninstallKeepalive,
} from "./keepalive.js";
import { authenticateWithPastedCookie, getAuthenticatedSession, getAuthenticatedSessionWithBrowserFallback, invalidateCachedSession } from "./auth.js";
import { browserCookieStores, cookieStoresBlocked } from "./cookie-stores.js";
import { signInInteractively } from "./onboarding.js";
import { readSecretLine } from "./secret-input.js";
import { configureTerminalTables } from "./terminal-table.js";
import { MOODLE_TAGLINE, MOODLE_WORDMARK, showWordmark } from "./wordmark.js";
import { VERSION } from "./version.js";
import { filterDiscussionToPost, parseDiscussionReference, parseForumReference } from "./forum.js";
import { looksLikeUrl, resolveTopLevelUrl } from "./url-resolver.js";
import { createMcpCommandService, type McpCommandOutput, type McpCommandService } from "./mcp/cli.js";
import { describeProgram } from "./command-contract.js";
import { ONBOARDING_COPY } from "./mcp/deployment/onboarding.js";

interface CliIO {
  stdout?: NodeJS.WriteStream | { write(chunk: string): boolean };
  stderr?: NodeJS.WriteStream | { write(chunk: string): boolean };
  stdin?: NodeJS.ReadStream;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  rootArgs?: string[];
  mcpService?: McpCommandService;
}

interface Runtime {
  client: MoodleClient | null;
  /** A spinner owns stderr while this is set, so the request indicator stays quiet. */
  busy: boolean;
  getClient: () => Promise<MoodleClient>;
  baseUrl: () => Promise<string>;
  output: (data: unknown, formatter: () => string, options: OutputCommandOptions) => Promise<void>;
  screen: (data: Record<string, unknown>, options?: OutputCommandOptions) => string;
  count: (key: "limit" | "days", local?: number, fallback?: number) => number | undefined;
}

interface OutputCommandOptions {
  json?: boolean;
  yaml?: boolean;
  table?: boolean;
  fields?: string;
  output?: string;
  pretty?: boolean;
}

const NOUNS: readonly NounSpec[] = [
  { name: "units", aliases: ["courses"], verbs: ["list", "show"], defaultByArity: { 0: "list", 1: "show" } },
  { name: "activities", verbs: ["list", "show"], defaultByArity: { 0: "list", 1: "list" }, valueFlags: ["--limit", "--section"] },
  { name: "grades", verbs: ["list"], defaultByArity: { 0: "list", 1: "list" } },
  {
    name: "forums",
    verbs: ["list", "show", "search"],
    defaultByArity: { 0: "list", 1: "list" },
    valueFlags: ["--limit", "--course", "--forum", "--limit-forums", "--limit-discussions", "--unit"],
  },
  { name: "threads", verbs: ["show"], defaultByArity: { 1: "show" }, valueFlags: ["--post", "--limit", "--offset"] },
];

export function buildProgram(io: CliIO = {}): Command {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const program = createProgram({ name: "moodle", version: VERSION, description: MOODLE_TAGLINE });
  banner(program, MOODLE_WORDMARK);
  program.configureOutput({
    writeOut: (text) => stdout.write(text),
    writeErr: (text) => stderr.write(text),
    outputError: () => undefined,
  });
  program.hook("preAction", (_command, actionCommand) => {
    resolveFormat(actionCommand.optsWithGlobals(), Boolean(stdout && "isTTY" in stdout && stdout.isTTY));
  });
  program.option("--no-cache", "Bypass session cache reads and writes.");
  program.argument("[target...]", "Unit name, section, item phrase, or Moodle URL");
  program.option("--pretty", "Indent JSON output.");
  program.option("--limit <number>", "Maximum returned rows.", parsePositiveInt);
  program.option("--days <number>", "Deadline window in days.", parsePositiveInt);
  const verbose = program.options.find(option => option.long === "--verbose");
  if (verbose) { verbose.short = "-v"; verbose.flags = "-v, --verbose"; }
  program.showSuggestionAfterError(true);

  // Screens are the only place the terminal's real width matters; one helper keeps
  // every call site honest about it.
  const screen = (data: Record<string, unknown>, options: OutputCommandOptions = {}) => renderScreen(data, {
    // Terminals without a size report 0 columns; the default is better than 40.
    width: (stdout as Partial<NodeJS.WriteStream>).columns || undefined,
    color: !process.env.NO_COLOR && program.opts().color !== false && outputFormat({ ...program.opts(), ...options }, stdout) === "table",
  });
  configureTerminalTables({ color: () => colorEnabled(stdout as { isTTY?: boolean }, io.env) && program.opts().color !== false });

  // Commander hands a flag declared on both the program and a subcommand to the
  // program, so a local --limit or --days never arrives. What the user typed wins,
  // then the command's own default.
  const count = (key: "limit" | "days", local?: number, fallback?: number) => (program.opts()[key] as number | undefined) ?? local ?? fallback;

  const runtime: Runtime = {
    client: null,
    busy: false,
    screen,
    count,
    baseUrl: async () => (await loadConfig({ env: io.env, cwd: io.cwd, homeDir: io.homeDir, stdin: io.stdin, stderr: stderr as NodeJS.WritableStream, fetch: io.fetchImpl })).baseUrl,
    getClient: async () => {
      if (!runtime.client) {
        const baseUrl = await runtime.baseUrl();
        // One indicator for the whole command, however many requests run at once.
        let inflight = 0;
        let displayed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const connect = () => createMoodleClient(baseUrl, {
          env: io.env,
          fetchImpl: async (input, init) => {
            const started = Date.now();
            const tty = Boolean("isTTY" in stderr && stderr.isTTY) && !program.opts().json && !io.rootArgs?.includes("--json") && !runtime.busy;
            if (tty && inflight++ === 0) timer = setTimeout(() => { displayed = true; stderr.write("Loading Moodle…"); }, 300);
            try { return await (io.fetchImpl ?? fetch)(input, init); }
            finally {
              if (tty && --inflight === 0) {
                clearTimeout(timer);
                if (displayed) { stderr.write("\r\x1b[2K"); displayed = false; }
              }
              if (program.opts().verbose) {
                const url = new URL(input instanceof Request ? input.url : String(input));
                const methods = url.pathname.endsWith("/lib/ajax/service.php") ? url.searchParams.get("info") ?? "" : "";
                stderr.write(`${init?.method ?? "GET"} ${url.pathname}${methods ? ` (${methods})` : ""} ${Date.now() - started}ms\n`);
              }
            }
          },
          homeDir: io.homeDir,
          noCache: Boolean(program.opts().cache === false),
        });
        try {
          runtime.client = await connect();
        } catch (error) {
          // A person with no session is walked through the browser sign-in once; an agent gets the auth error.
          if (!(error instanceof AuthError) || !human()) throw error;
          await signIn(baseUrl);
          runtime.client = await connect();
        }
      }
      return runtime.client;
    },
    output: async (data, formatter, options) => {
      const merged = { ...program.opts(), ...options } as OutputCommandOptions;
      const format = outputFormat(merged, stdout);
      const human = format === "table" ? formatter() : "";
      const text = format === "table"
        ? `${human}${human.includes("Try  ") ? "" : `\n\n${tryLines(["moodle due", "moodle units", "moodle --help"])}`}\n`
        : format === "json"
          ? `${JSON.stringify(JSON.parse(render(data, { format, fields: parseFields(data, merged.fields) })), null, merged.pretty ? 2 : undefined)}\n`
          : render(data, { format, fields: parseFields(data, merged.fields) });
      if (io.stdout && !merged.output) {
        stdout.write(text);
      } else {
        await writeOutput(text, { output: merged.output });
      }
    },
  };
  let mcpService: McpCommandService | undefined = io.mcpService;
  const getMcpService = (): McpCommandService => {
    mcpService ??= createMcpCommandService({
      env: io.env,
      cwd: io.cwd,
      homeDir: io.homeDir,
      stdin: io.stdin,
      stdout: stdout as NodeJS.WritableStream,
      stderr: stderr as NodeJS.WritableStream,
      fetchImpl: io.fetchImpl,
      // Progress goes to stderr and the summary to stdout, so both streams must want colour.
      color: () => colorEnabled(stdout as { isTTY?: boolean }, io.env)
        && colorEnabled(stderr as { isTTY?: boolean }, io.env)
        && program.opts().color !== false,
    });
    return mcpService;
  };

  const execute = async (name: Intent, args: Record<string, unknown>, options: OutputCommandOptions = {}, service?: IntentService) => {
    const runner = service ?? createIntentService(createMoodleGateway(await runtime.getClient()));
    const result = await runner.run(name, args);
    await runtime.output(result, () => screen(result, options), options);
  };

  // One rule for who is on the other end: a person at a terminal reading a table. Anyone
  // else (a pipe, --json, an agent's shell) gets errors with the flag to pass, never a prompt.
  const human = () => detectAudience({
    stdin: io.stdin ?? process.stdin,
    stdout: { isTTY: Boolean(stdout && "isTTY" in stdout && stdout.isTTY) },
    env: io.env ?? process.env,
    format: outputFormat(program.opts(), stdout),
  }) === "human";

  const theme = (): Theme => createTheme(colorEnabled(stderr as { isTTY?: boolean }, io.env) && program.opts().color !== false);

  // First run on this machine: the wordmark, one note, then whichever sign-in the person picks.
  const signIn = async (baseUrl: string): Promise<void> => {
    const ui = createUi({ input: io.stdin ?? process.stdin, output: stderr as Writable, interactive: true });
    const auth = { env: io.env, fetch: io.fetchImpl, homeDir: io.homeDir, captureMobileToken: true };
    runtime.busy = true;
    try {
      await signInInteractively(ui, {
        baseUrl,
        platform: process.platform,
        showWordmark,
        storesBlocked: async () => cookieStoresBlocked(await browserCookieStores({ homeDir: io.homeDir })),
        openInBrowser,
        readBrowserSession: () => getAuthenticatedSession(baseUrl, { ...auth, noCache: true, nonInteractive: true }),
        browserLogin: onBrowserOpened => getAuthenticatedSessionWithBrowserFallback(baseUrl, { ...auth, onBrowserOpened }),
        pasteLogin: () => pasteLogin(baseUrl, true),
        keepaliveInstalled: async () => (await keepaliveStatus(io.homeDir)).installed,
        installKeepalive: () => installKeepalive({ homeDir: io.homeDir }),
      });
    } finally {
      runtime.busy = false;
    }
  };

  const choose = async <T>(action: () => Promise<T>, retry: (id: number) => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) {
      if (!(error instanceof ReferenceError) || error.code !== "ambiguous" || !human()) throw error;
      const ui = createUi({ input: io.stdin ?? process.stdin, output: stderr as Writable, interactive: true });
      const hint = (c: Candidate) => c.code ?? c.type;
      const chosen = await ui.select(error.message, error.candidates.map(c => ({ value: c.id, label: c.name, ...(hint(c) ? { hint: hint(c) } : {}) })));
      return await retry(chosen);
    }
  };

  program.action(async (targets: string[], options: Record<string, unknown>) => {
    const merged = { ...parseRootOutputOptions(io.rootArgs ?? []), ...options };
    if (!targets.length) return execute("home", { days: program.opts().days }, merged);
    if (targets.length === 1 && looksLikeUrl(targets[0])) return dispatchUrl(runtime, targets[0], merged);
    if (targets[0] === "unit") throw new UsageError("Unknown command 'unit'.", "Did you mean 'units'? Run moodle units.");
    const client = await runtime.getClient();
    const courses = await client.getCourses();
    const service = createIntentService(createMoodleGateway(client));
    const parsed = await choose(async () => splitUnitPhrase(targets.join(" "), courses), async id => ({ course: courses.find(c => c.id === id)!, query: targets.slice(1).join(" ") }));
    if (!parsed) {
      // A bare target is a place to go, not a forum search: an unmatched one is an
      // error with the site's own unit list, not an empty result and exit 0.
      const query = targets.join(" ");
      if (!(await service.find(query, undefined, undefined, false)).length) {
        throw new ReferenceError("not_found", `No unit or item matches '${query}'. Your units: ${courses.map(c => c.shortname || c.fullname).join(", ")}.`, courses.map(c => ({ id: c.id, name: c.fullname || c.shortname, code: c.shortname || undefined })));
      }
      return execute("find", { query, limit: program.opts().limit }, merged, service);
    }
    const unit = parsed.course.id;
    const query = parsed.query;
    if (["grades", "news", "due"].includes(query)) return execute(query as Intent, { unit, ...(query !== "grades" ? { limit: program.opts().limit } : {}) }, merged, service);
    if (query === "files") return execute("find", { query: "*", unit, types: ["resource", "folder"], limit: program.opts().limit }, merged, service);
    if (query === "forums") { const rows = await createMoodleGateway(client).listForums({ courseId: unit }); return runtime.output({ forums: rows.map(f => ({ id: f.id, name: f.name, unit_id: f.course_id })), total: rows.length }, () => formatForumActivities(rows), merged); }
    if (!query) {
      let data = await service.run("unit", { unit });
      if (outputFormat(merged, stdout) === "table") {
        const current = (data.unit as { current_section?: { id: number } }).current_section;
        if (current) {
          const section = (await service.sections(unit)).find(s => s.id === current.id);
          if (section) data = await service.run("unit", { unit, section: section.name });
        }
        data = { ...data, ...await service.run("due", { unit }), ...await service.run("news", { unit, limit: 1 }) };
      }
      return runtime.output(data, () => screen(data), merged);
    }
    const sections = await service.sections(unit);
    try {
      const namedSection = sections.some(section => normalize(section.name).includes(normalize(query)));
      const numberedSection = /^\d+$/u.test(query) || /^\S+\s+\d+$/u.test(query);
      if (!namedSection && !numberedSection) throw new ReferenceError("not_found", "Not a section reference.", []);
      resolveSection(query, sections);
      return await execute("unit", { unit, section: query }, merged, service);
    } catch (error) { if (!(error instanceof ReferenceError)) throw error;
      if (error.code === "ambiguous") {
        return choose(async () => { throw error; }, async id => {
          const chosen = sections.find(section => section.id === id)!;
          const result = await createIntentService({ ...createMoodleGateway(client), getCourse: async () => ({ course: parsed.course, sections: [chosen] }) }).run("unit", { unit, section: chosen.name });
          await runtime.output(result, () => screen(result), merged);
        });
      }
    }
    return choose(() => execute("item", { ref: `${parsed.course.shortname || parsed.course.fullname} ${query}` }, merged, service), id => execute("item", { ref: id }, merged, service));
  });

  for (const name of ["due", "news"] as const) {
    const command = addOutputOptions(program.command(name).description(humanDescription(name)).argument("[unit]", "Unit code, name, id or URL"));
    if (name === "due") command.option("--days <number>", "Deadline window in days.", parsePositiveInt);
    command
      .option("--limit <number>", "Maximum returned rows.", parsePositiveInt)
      .action(async (unit: string | undefined, options: OutputCommandOptions & { days?: number; limit?: number }) => execute(name, { unit, limit: count("limit", options.limit), ...(name === "due" ? { days: count("days", options.days) } : {}) }, options));
  }
  addOutputOptions(program.command("find").description(humanDescription("find")).argument("<query>", "Words to look for").argument("[unit]", "Unit code, name, id or URL"))
    .option("--limit <number>", "Maximum returned rows.", parsePositiveInt)
    .option("--types <types>", "Comma-separated activity types.")
    .action(async (query: string, unit: string | undefined, options: OutputCommandOptions & { limit?: number; types?: string }) => execute("find", { query, unit, limit: count("limit", options.limit), types: options.types?.split(",") }, options));
  addOutputOptions(program.command("attempt").description(humanDescription("attempt")).argument("<ref>", "Quiz attempt id or review URL"))
    .action(async (ref: string, options: OutputCommandOptions) => execute("attempt", { attempt: ref }, options));
  // Maintainer aid: parser work needs the real page markup, and the browser session is
  // only readable from here. Hidden from help and the generated contract on purpose.
  const dev = program.command("dev", { hidden: true }).description("Maintainer utilities.");
  dev.command("fetch").description("Print a same-site page as HTML with the session; sesskey values are redacted.").argument("<url>")
    .action(async (url: string) => {
      const client = await runtime.getClient();
      if (new URL(url).origin !== new URL(client.baseUrl).origin) throw new UsageError("The URL must belong to the configured Moodle site.");
      const html = await (await client.requestAbsolute(url)).text();
      stdout.write(`${redactSesskey(html)}\n`);
    });
  addOutputOptions(mutating(program.command("update").description("Update the package and redeploy the managed MCP Worker when either is behind.")))
    .option("--check", "Report versions without installing or deploying.")
    .option("--quiet", "Print nothing; refresh the cached version only.")
    .action(async (options: OutputCommandOptions & { check?: boolean; quiet?: boolean }) => {
      const updateOptions = { homeDir: io.homeDir, env: io.env, fetchImpl: io.fetchImpl };
      if (options.quiet) { await refreshLatestVersion(updateOptions); return; }
      const worker = await getMcpService().workerState();
      const palette = theme();
      const workerLine = worker === null ? [] : [`${palette.dim("Worker:")} ${palette.status(worker.behind ? "behind this package" : worker.ready ? "current" : "not ready", { current: "success", "behind this package": "warning", "not ready": "danger" })}`];
      if (options.check) {
        const latest = await refreshLatestVersion(updateOptions);
        const available = isNewerVersion(latest ?? undefined, VERSION);
        const report = { current: VERSION, latest, update_available: available, ...(worker ? { worker_behind: worker.behind, worker_ready: worker.ready } : {}) };
        await runtime.output(report, () => [
          `${palette.dim("moodle-cli:")} ${palette.key(VERSION)} ${available ? palette.tone("warning", `→ ${latest} available`) : latest ? palette.dim("(latest)") : palette.tone("warning", "(npm unreachable)")}`,
          ...workerLine,
          ...(available || worker?.behind ? ["", tryLines(["moodle update"])] : []),
        ].join("\n"), options);
        return;
      }
      const report = await runUpdate({ ...updateOptions, workerBehind: worker?.behind });
      const stale = worker && !worker.ready && !report.deployed ? [`${palette.tone("warning", "The Worker is deployed but not answering.")} ${tryLines(["moodle mcp status"])}`] : [];
      await runtime.output({ ...report, ...(worker ? { worker_ready: worker.ready } : {}) }, () => [palette.tone(report.updated || report.deployed ? "success" : "muted", report.note), ...stale].join("\n"), options);
    });
    addOutputOptions(program.command("get").description("Download a resource by id, URL, or UNIT TASK phrase.").argument("<ref>", "Resource id, URL, or UNIT TASK phrase"))
    .option("--to <directory>", "Destination directory.")
    .option("--force", "Replace an existing file atomically.")
    .action(async (ref: string, options: OutputCommandOptions & { to?: string; force?: boolean }) => {
      const client = await runtime.getClient();
      const service = createIntentService(createMoodleGateway(client));
      const source = await choose(() => service.fileSource(ref), id => Promise.resolve(id));
      const receipt = await downloadMoodleFile(client, { source: String(source), directory: options.to ? path.resolve(io.cwd ?? process.cwd(), options.to) : undefined, force: options.force });
      await runtime.output(receipt, () => formatDownloadReceipt(receipt), options);
    });
  addOutputOptions(mutating(program.command("submit").description(humanDescription("submit")).summary("Upload files into an assignment").argument("<ref>", "Assignment id, URL, or UNIT TASK phrase").argument("[files...]", "Local files to upload")))
    .option("--final", "Also submit for grading. Moodle does not allow undoing this.")
    .option("--replace", "Remove the files already in the submission first.")
    .option("--accept-statement", "Agree to the site's submission statement when it requires one.")
    .action(async (ref: string, files: string[], options: OutputCommandOptions & { final?: boolean; replace?: boolean; acceptStatement?: boolean }) => {
      const interactive = human();
      // Same rule cli-kit's confirm applies, checked before the plan touches the site or the files.
      if (!program.opts().dryRun && !program.opts().yes && !interactive) throw new UsageError("Mutation requires --yes when stdin is not interactive.", "Run with --dry-run to see the plan first.");
      const client = await runtime.getClient();
      const service = createIntentService(createMoodleGateway(client));
      const args = { files: files.map(file => resolveSubmissionPath(file, io.cwd ?? process.cwd())), final: Boolean(options.final), replace: Boolean(options.replace), accept_statement: Boolean(options.acceptStatement) };
      // The plan reads the files and every Moodle page the upload needs, so most refusals happen before any prompt.
      const plan = await choose(() => service.run("submit", { ref, ...args, dry_run: true }), id => service.run("submit", { ref: id, ...args, dry_run: true }));
      const planned = plan.submission as SubmissionReceipt;
      if (program.opts().dryRun) return runtime.output(plan, () => formatSubmissionReceipt(planned), options);
      if (!await confirm({ summary: submissionSummary(planned, args.final, theme()) }, { yes: Boolean(program.opts().yes), dryRun: false, interactive })) return;
      // The upload is the one long step a person watches, so it gets a spinner that names each file.
      const spin = interactive ? createUi({ input: io.stdin ?? process.stdin, output: stderr as Writable, interactive: true }).spinner() : undefined;
      runtime.busy = true;
      spin?.start("Preparing the upload");
      let result: Record<string, unknown>;
      try {
        const live = createIntentService(createMoodleGateway(client, { onSubmitProgress: message => spin?.message(message) }));
        result = await live.run("submit", { ref: planned.id, ...args, dry_run: false });
        const receipt = result.submission as SubmissionReceipt;
        spin?.stop(receipt.uploads.length ? `Uploaded ${receipt.uploads.map(file => file.name).join(", ")} to ${receipt.name}` : `Submitted ${receipt.name}`);
      } catch (error) {
        spin?.error("The upload did not complete");
        throw error;
      } finally {
        runtime.busy = false;
      }
      await runtime.output(result, () => formatSubmissionReceipt(result.submission as SubmissionReceipt), options);
    });
  const quiz = program.command("quiz").description("Take a quiz: start an attempt, answer questions, finish it. Beta.").summary("Take a quiz (beta)");
  quiz.addHelpText("after", `\n${QUIZ_NOTICE.join("\n")}\n`);
  // Every quiz write needs an informed yes: the notice is part of the prompt, and a pipe must pass --yes.
  const quizConsent = async (summary: string): Promise<boolean> => {
    const palette = theme();
    if (!program.opts().yes && !human()) throw new UsageError("Quiz actions need --yes when stdin is not interactive.", QUIZ_NOTICE.join(" "));
    const notice = [palette.tone("warning", "BETA"), ...QUIZ_NOTICE.map(line => palette.dim(line))].join("\n");
    return confirm({ summary: `${notice}\n\n${summary}` }, { yes: Boolean(program.opts().yes), dryRun: false, interactive: human() });
  };
  const attemptNext = (page: AttemptPage): string[] => {
    const open = page.navigation.find(entry => entry.number !== "i" && /not yet|not answered/iu.test(entry.state));
    if (!open) return [`moodle quiz finish ${page.attempt} ${page.quiz_id}`];
    return [
      `moodle quiz answer ${page.attempt} ${page.quiz_id} ${open.number} <answer>`,
      ...(open.page === page.page ? [] : [`moodle quiz show ${page.attempt} ${page.quiz_id} --page ${open.page + 1}`]),
    ];
  };
  const showPage = (page: AttemptPage, palette: Theme) => `${palette.tone("warning", "BETA")} ${formatAttemptPage(page)}\n\n${tryLines(attemptNext(page))}`;
  addOutputOptions(mutating(quiz.command("start").description("Start a new attempt, or continue the one in progress, and show its first page.").argument("<ref>", "Quiz id, URL, or UNIT TASK phrase")))
    .option("--password <password>", "Quiz access password for scripts; at a terminal you are asked for it instead.")
    .action(async (ref: string, options: OutputCommandOptions & { password?: string }) => {
      const client = await runtime.getClient();
      const service = createIntentService(createMoodleGateway(client));
      const id = await choose(() => service.resolveItem(ref), id => Promise.resolve(id));
      if (!program.opts().dryRun && !await quizConsent(`Start or continue an attempt on quiz ${theme().target(String(id))}. Moodle records the attempt and its start time.`)) return;
      if (program.opts().dryRun) return runtime.output({ planned: "start", quiz_id: id }, () => `Would start an attempt on quiz ${id}.`, options);
      // The password is only asked for when Moodle's pre-flight form wants one, so most quizzes never see a prompt.
      const password = async (): Promise<string | null> => {
        if (options.password) return options.password;
        const input = io.stdin ?? process.stdin;
        if (!human() || !input.isTTY) return null;
        return readSecretLine(input, stderr as NodeJS.WritableStream, "Quiz password (not echoed): ");
      };
      const page = await client.startQuizAttempt(id, { password });
      await runtime.output({ attempt: page }, () => showPage(page, theme()), options);
    });
  addOutputOptions(quiz.command("show").description("Show one page of an attempt in progress: questions, options and saved answers.").argument("<attempt>", "Attempt id").argument("<quiz>", "Quiz id"))
    .option("--page <n>", "Page number, starting at 1.", parsePositiveInt)
    .action(async (attempt: string, quizId: string, options: OutputCommandOptions & { page?: number }) => {
      const client = await runtime.getClient();
      const page = await client.getQuizAttemptPage(parsePositiveInt(attempt), parsePositiveInt(quizId), (options.page ?? 1) - 1);
      await runtime.output({ attempt: page }, () => showPage(page, theme()), options);
    });
  addOutputOptions(mutating(quiz.command("answer").description("Save one answer: option letters for a choice question (b, or a,c), the text otherwise.").argument("<attempt>", "Attempt id").argument("<quiz>", "Quiz id").argument("<question>", "Question number as shown").argument("[answer]", "Option letters or answer text")))
    .option("--from <file>", "Read the answer text from a file.")
    .action(async (attempt: string, quizId: string, question: string, answer: string | undefined, options: OutputCommandOptions & { from?: string }) => {
      const value = options.from ? await readFile(path.resolve(io.cwd ?? process.cwd(), options.from), "utf8") : answer;
      if (!value?.trim()) throw new UsageError("Give the answer as an argument or with --from <file>.");
      const request = { attemptId: parsePositiveInt(attempt), quizId: parsePositiveInt(quizId), question, value };
      const palette = theme();
      const preview = value.trim().length > 80 ? `${value.trim().slice(0, 77)}...` : value.trim();
      if (program.opts().dryRun) return runtime.output({ planned: "answer", ...request }, () => `Would answer question ${question} of attempt ${attempt} with: ${preview}`, options);
      if (!await quizConsent(`Save ${palette.subject(preview)} as the answer to question ${palette.target(question)} of attempt ${attempt}.`)) return;
      const client = await runtime.getClient();
      const page = await client.answerQuizQuestion(request);
      await runtime.output({ attempt: page }, () => showPage(page, palette), options);
    });
  addOutputOptions(mutating(quiz.command("finish").description("Submit the attempt for grading. Moodle does not allow undoing this.").argument("<attempt>", "Attempt id").argument("<quiz>", "Quiz id")))
    .action(async (attempt: string, quizId: string, options: OutputCommandOptions) => {
      const client = await runtime.getClient();
      const ids = [parsePositiveInt(attempt), parsePositiveInt(quizId)] as const;
      const summary = await client.getQuizAttemptSummary(...ids);
      if (program.opts().dryRun) return runtime.output({ planned: "finish", summary }, () => formatAttemptSummary(summary), options);
      const palette = theme();
      const open = summary.rows.filter(row => /not yet answered/iu.test(row.state));
      const warning = open.length ? `\n${palette.tone("danger", `${open.length} question${open.length === 1 ? "" : "s"} not yet answered: ${open.map(row => row.number).join(", ")}`)}` : "";
      if (!await quizConsent(`${formatAttemptSummary(summary)}${warning}\n${palette.tone("warning", "Submit all and finish. Moodle does not allow undoing this.")}`)) return;
      const receipt = await client.finishQuizAttempt(...ids);
      await runtime.output({ finished: receipt }, () => formatAttemptFinish(receipt), options);
    });
  addOutputOptions(program.command("open").description("Open a unit or activity reference in the browser.").argument("<ref>", "Unit or activity id, URL, or UNIT TASK phrase"))
    .action(async (ref: string, options: OutputCommandOptions) => {
      const client = await runtime.getClient();
      let url: string;
      if (looksLikeUrl(ref)) { await resolveTopLevelUrl(client.baseUrl, ref); url = ref; }
      else {
        const parsed = splitUnitPhrase(ref, await client.getCourses());
        if (parsed && !parsed.query) url = `${client.baseUrl}/course/view.php?id=${parsed.course.id}`;
        else { const id = await createIntentService(createMoodleGateway(client)).resolveItem(ref); const item = await client.getActivity(id); url = item.url; }
      }
      if (!url || !/^https?:/u.test(url)) throw new UsageError("This item has no browser URL.");
      await openInBrowser(url);
      await runtime.output({ opened: url }, () => `Opened ${url}`, options);
    });

  addOutputOptions(program.command("user").description("Show authenticated user info.")).action(async (options: OutputCommandOptions) => {
    const user = await (await runtime.getClient()).getSiteInfo();
    await runtime.output({ user: { id: user.userid, name: user.fullname, siteurl: user.siteurl, timezone: user.timezone } }, () => formatUser(user), options);
  });

  const units = program.command("units").aliases(["courses"]).description("Inspect enrolled units.");
  addOutputOptions(units.command("list").description("List enrolled units.")).action(async (options: OutputCommandOptions) => {
    await execute("units", {}, options);
  });

  addOutputOptions(units.command("show").description("Show unit detail with sections.").argument("<unit>", "Unit ID or unique name")).action(
    async (unit: string, options: OutputCommandOptions) => {
      const client = await runtime.getClient();
      const courseId = await client.resolveCourseReference(unit);
      await execute("unit", { unit: courseId }, options);
    },
  );

  addOutputOptions(program.command("todo").description("List upcoming actionable timeline items."))
    .option("--limit <number>", "Maximum number of items.", parsePositiveInt, 20)
    .option("--days <number>", "Only include items due within the next N days.", parsePositiveInt)
    .action(async (options: OutputCommandOptions & { limit: number; days?: number }) => {
      await execute("due", { limit: count("limit", options.limit), days: count("days", options.days) }, options);
    });

  addOutputOptions(program.command("alerts").description("List notifications and message counts."))
    .option("--limit <number>", "Maximum number of notifications.", parsePositiveInt, 20)
    .action(async (options: OutputCommandOptions & { limit: number }) => {
      const alerts = await (await runtime.getClient()).getAlerts(count("limit", options.limit)!);
      await runtime.output(stripEmpty({ alerts }), () => formatAlerts(alerts), options);
    });

  addOutputOptions(program.command("overview").description("Show a compact multi-source overview."))
    .option("--todo-limit <number>", "Maximum number of todo items.", parsePositiveInt, 5)
    .option("--todo-days <number>", "Only include todo items due within the next N days.", parsePositiveInt)
    .option("--alerts-limit <number>", "Maximum number of notifications.", parsePositiveInt, 5)
    .action(async (options: OutputCommandOptions & { todoLimit: number; todoDays?: number; alertsLimit: number }) => {
      await execute("home", { days: options.todoDays }, options);
    });

  const activities = program.command("activities").description("Inspect activities.");
  addOutputOptions(activities.command("list").description("List activities in a unit; narrow by section.").argument("<unit>", "Unit code, name, id or URL"))
    .option("--section <section>", "Section number or name.")
    .option("--limit <number>", "Maximum returned activities.", parsePositiveInt, 200)
    .option("--include-labels", "Include inline labels.")
    .action(async (unit: string, options: OutputCommandOptions & { section?: string; limit: number; includeLabels?: boolean }) => {
      const client = await runtime.getClient();
      const courseId = await client.resolveCourseReference(unit);
      const sections = await client.getCourseContents(courseId);
      const chosen = options.section ? [resolveSection(options.section, sections).section] : sections;
      const rows = chosen.flatMap(section => section.activities.filter(a => options.includeLabels || a.modname !== "label").map(a => activitySchema.parse(stripEmpty(activityRow(a, section)))));
      const result = stripEmpty({ activities: rows.slice(0, count("limit", options.limit)), total: rows.length }) as Record<string, unknown>;
      await runtime.output(result, () => runtime.screen(result, options), options);
    });
  addOutputOptions(activities.command("show").description("Show activity details; resource and folder files can be passed to moodle get or download.").summary("Show activity details").argument("<id>", "Course-module ID")).action(
    async (id: string, options: OutputCommandOptions) => {
      await execute("item", { ref: parsePositiveInt(id) }, options);
    },
  );

  addOutputOptions(
    program
      .command("download")
      .alias("dl")
      .description("Download one authenticated Moodle file.")
      .argument("<source>", "Course-module ID or authenticated Moodle file URL")
      .option("--dest <path>", "Exact downloaded file path")
      .option("--force", "Atomically replace an existing destination"),
  ).action(async (source: string, options: OutputCommandOptions & { dest?: string; force?: boolean }) => {
    const destination = options.dest
      ? path.resolve(io.cwd ?? process.cwd(), options.dest)
      : undefined;
    const receipt = await downloadMoodleFile(await runtime.getClient(), {
      source,
      destination,
      force: options.force,
    });
    await runtime.output(receipt, () => formatDownloadReceipt(receipt), options);
  });

  const grades = program.command("grades").description("Inspect grades.");
  addOutputOptions(grades.command("list").description("Show grade details for a unit.").argument("[unit]", "Unit code, name, id or URL").option("--graded-only", "Only return graded items.")).action(
    async (unit: string | undefined, options: OutputCommandOptions & { gradedOnly?: boolean }) => execute("grades", { unit, graded_only: options.gradedOnly }, options),
  );

  const threads = program.command("threads").description("Inspect forum discussion threads.");
  addOutputOptions(threads.command("show").description("Show posts in a forum discussion.").argument("<discussion>", "Discussion ID or URL"))
    .option("--limit <number>", "Maximum returned posts.", parsePositiveInt)
    .option("--offset <number>", "Skip this many posts.", value => { const n = Number(value); if (!Number.isInteger(n) || n < 0) throw new UsageError("Expected a nonnegative offset."); return n; }, 0)
    .option("--post <id>", "Show a specific post ID.", parsePositiveInt)
    .option("--body", "Show full post body.")
    .action(async (discussion: string, options: OutputCommandOptions & { post?: number; body?: boolean; limit?: number; offset?: number }) => {
      const parsed = parseDiscussionReference(discussion);
      const postId = options.post ?? parsed.postId;
      const thread = filterDiscussionToPost(await (await runtime.getClient()).getForumDiscussion(parsed.discussionId), postId);
      if (postId) await runtime.output(stripEmpty({ thread: { id: thread.id, name: thread.subject, unit_id: thread.course_id, forum_id: thread.forum_id, url: thread.url, posts: thread.posts.map(p => postRow(p, thread.subject)), posts_total: thread.posts.length, offset: 0 } }), () => formatForumDiscussion(thread, { showBody: options.body }), options);
      else await execute("thread", { discussion_id: parsed.discussionId, limit: count("limit", options.limit), offset: options.offset }, options);
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
      const total = refs.length;
      refs = refs.slice(0, count("limit", options.limit));
      await runtime.output(stripEmpty({ threads: refs.map(t => ({ id: t.id, name: t.subject })), total }), () => formatForumDiscussionRefs(forumId, refs), options);
    });

  addOutputOptions(forums.command("list").description("List forum activities in a unit.").argument("<unit>", "Unit ID or unique name"))
    .option("--limit <number>", "Maximum number of forums.", parsePositiveInt, 50)
    .action(async (unit: string, options: OutputCommandOptions & { limit: number }) => {
      const client = await runtime.getClient();
      const courseId = await client.resolveCourseReference(unit);
      let forums = await client.getForums(courseId);
      const total = forums.length;
      forums = forums.slice(0, count("limit", options.limit));
      await runtime.output(stripEmpty({ forums: forums.map(f => ({ id: f.id, name: f.name, unit_id: f.course_id })), total }), () => formatForumActivities(forums), options);
    });

  addForumSearchCommand(forums.command("search").description("Search forum discussion titles and post text."), runtime, 20);

  addOutputOptions(program.command("doctor").description("Diagnose runtime, browser access, session, background jobs and MCP setup.").summary("Diagnose runtime, session and MCP setup")).action(async (options: OutputCommandOptions) => {
    const result = await doctor(io);
    await runtime.output(result, () => result.checks.map(c => `${c.status.toUpperCase()} ${c.name}: ${c.detail}${c.hint ? `\n  ${c.hint}` : ""}`).join("\n") + `\n\n${tryLines(doctorNextSteps(result.checks))}`, options);
    // A health check that always succeeds cannot be scripted against.
    if (result.checks.some(c => c.status === "fail")) process.exitCode = 3;
  });
  program.command("completion").description("Print shell completion for zsh, bash or fish.").addArgument(program.createArgument("<shell>", "Shell to target").choices(["zsh", "bash", "fish"])).action((shell: string) => {
    const names = program.commands.filter(c => c.name() !== "help").flatMap(c => [c.name(), ...c.aliases()]);
    if (shell === "bash") stdout.write(`complete -W '${names.join(" ")}' moodle\n`);
    else if (shell === "zsh") stdout.write(`#compdef moodle\n_arguments '1:command:(${names.join(" ")})' '*:reference:'\n`);
    else if (shell === "fish") stdout.write(names.map(n => `complete -c moodle -f -a '${n}'`).join("\n") + "\n");
    else throw new UsageError("Choose zsh, bash or fish.");
  });
  addOutputOptions(mutating(program.command("uninstall").description("Remove local background jobs; optionally remove the selected Worker and configuration.").summary("Remove background jobs, Worker and config")))
    .option("--remote", "Also remove the configured managed MCP deployment.")
    .option("--purge", "Also delete local Moodle CLI configuration, receipts and cache.")
    .action(async (options: OutputCommandOptions & { remote?: boolean; purge?: boolean }) => {
      const home = io.homeDir ?? homedir();
      const jobs = await ownedJobs(home);
      const receipts = await readdir(path.join(home, ".config", "moodle-cli", "mcp", "deployments")).catch(() => [] as string[]);
      const result = { jobs: jobs.map(j => j.path), remote: Boolean(options.remote), purge: Boolean(options.purge), config: path.join(home, CONFIG_DIR_NAME), cache: path.join(home, CACHE_DIR_NAME), package_command: "npm rm -g moodle-cli (or bun remove -g moodle-cli); for the standalone install: rm ~/.local/bin/moodle", remaining: options.remote ? "Only the configured Worker is removed. Other profiles remain remote." : "Remote Workers and credentials remain unless removed with moodle mcp remove." };
      if (program.opts().dryRun) return runtime.output(result, () => JSON.stringify(result, null, 2), options);
      if (options.purge && receipts.length && !options.remote) throw new UsageError("Managed deployment receipts exist; remove the Worker before purging its recovery information.", "Run moodle mcp remove for each configured site, then moodle uninstall --purge.");
      if (options.purge && receipts.length > 1) throw new UsageError("Multiple managed deployment receipts exist; remove each Worker before purging configuration.");
      if (!await confirm({ summary: `Remove Moodle background jobs${options.remote ? ", the configured Worker" : ""}${options.purge ? ", configuration and cache" : ""}.` }, { yes: Boolean(program.opts().yes), dryRun: false, interactive: human() })) return;
      if (options.remote) await getMcpService().remove({ yes: true });
      if (process.platform === "darwin") await uninstallKeepalive({ homeDir: home });
      const renewal = new DefaultRenewalIntegration({ homeDirectory: home, executable: process.execPath });
      const profiles = new Set([...jobs.map(j => j.profile), ...receipts.map(n => n.replace(/\.json$/u, ""))].filter((p): p is string => Boolean(p) && /^[a-z0-9_-]+$/u.test(p!)));
      for (const profile of profiles) {
        await renewal.remove(profile);
        if (options.purge) await rm(path.join(home, "Library", "Logs", `com.moodle-cli.mcp-renewal.${profile}.log`), { force: true });
      }
      if (options.purge) { await rm(result.config, { recursive: true, force: true }); await rm(result.cache, { recursive: true, force: true }); }
      await runtime.output(result, () => `Moodle background jobs removed.\n${result.remaining}\n${result.package_command}`, options);
    });

  const auth = program.command("auth").description("Session and keepalive utilities.");

  addOutputOptions(auth.command("status").description("Show cached session freshness and keepalive state.")).action(
    async (options: OutputCommandOptions) => {
      const baseUrl = await runtime.baseUrl();
      const status = await getAuthStatus(baseUrl, { homeDir: io.homeDir, fetchImpl: io.fetchImpl });
      const cookieSqlite = runtimeSupportsCookies();
      const note = `Runtime: ${process.versions.bun ? "bun" : "node"} ${process.versions.bun ?? process.versions.node}; ${cookieSqlite ? "SQLite cookie support available" : "needs Node 22.13+ or Bun for browser SQLite"}. Run moodle doctor.`;
      await runtime.output({ ...status, runtime: note }, () => `${formatAuthStatus(status)}\n${note}`, options);
    },
  );

  addOutputOptions(
    auth
      .command("login")
      .description("Sign in through a browser the CLI controls, then capture the session.")
      .option("--paste", "Take the MoodleSession cookie from a prompt instead of the browser store."),
  ).action(
    async (options: OutputCommandOptions & { paste?: boolean }) => {
      const baseUrl = await runtime.baseUrl();
      const humanOutput = outputFormat(options, stdout) === "table";
      const session = options.paste
        ? await pasteLogin(baseUrl, humanOutput)
        : await getAuthenticatedSessionWithBrowserFallback(baseUrl, {
          env: io.env,
          fetch: io.fetchImpl,
          homeDir: io.homeDir,
          captureMobileToken: true,
          onBrowserOpened: humanOutput
            ? () => stderr.write("A browser window opened. Sign in there; I'll capture the session automatically.\n")
            : undefined,
        });
      const result = { base_url: baseUrl, userid: session.userid, cookie_source: session.cookie.source ?? "unknown" };
      await runtime.output(result, () => `Authenticated as userid ${result.userid} via ${result.cookie_source}`, options);
    },
  );

  async function pasteLogin(baseUrl: string, humanOutput: boolean) {
    const input = io.stdin ?? process.stdin;
    if (humanOutput && input.isTTY) {
      stderr.write(`Copy the ${MOODLE_SESSION_COOKIE_PREFIX} cookie for ${baseUrl} from your browser's developer tools.\nThe value is not echoed and is stored in the encrypted session cache.\n`);
    }
    const raw = await readSecretLine(input, stderr as NodeJS.WritableStream, input.isTTY ? `${MOODLE_SESSION_COOKIE_PREFIX}: ` : "");
    if (raw === null) {
      throw new CliError("cancelled", "Login cancelled.");
    }
    return authenticateWithPastedCookie(baseUrl, raw, { env: io.env, fetch: io.fetchImpl, homeDir: io.homeDir, captureMobileToken: true });
  }

  const keepalive = addOutputOptions(
    auth
      .command("keepalive")
      .description("Renew the Moodle session once; used by the background keepalive agent.").summary("Renew the session once")
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
      { yes: Boolean(globals.yes), dryRun: Boolean(globals.dryRun), interactive: human() },
    )) return;
    const baseUrl = await runtime.baseUrl();
    await getAuthenticatedSessionWithBrowserFallback(baseUrl, { env: io.env, homeDir: io.homeDir, fetch: io.fetchImpl, noCache: true, nonInteractive: true, captureMobileToken: true });
    const result = await installKeepalive({ homeDir: io.homeDir, intervalMinutes: options.interval });
    await runtime.output(result, () => `Keepalive installed: renews every ${result.interval_minutes} min\nAgent: ${result.plist_path}\nLog: ${result.log_path}`, options);
  });

  addOutputOptions(mutating(keepalive.command("uninstall").description("Remove the keepalive launch agent."))).action(
    async (options: OutputCommandOptions) => {
      const globals = program.opts();
      if (!await confirm(
        { summary: "Remove the Moodle session keepalive agent." },
        { yes: Boolean(globals.yes), dryRun: Boolean(globals.dryRun), interactive: human() },
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

  const mcp = program.command("mcp").description("Deploy a private MCP Worker on Cloudflare; encrypted session storage and local renewal. Free-tier limits apply.").summary("Private MCP server on Cloudflare");
  addOutputOptions(mutating(mcp.command("deploy").description("Deploy or update the managed Moodle MCP server.")))
    .option("--dry-run", "Preview deployment changes without applying them.")
    .option("--repair", "Repair authentication and managed deployment state.")
    .option("--rotate-key", "Rotate the session encryption key and migrate the active session.")
    .option("--rotate-token", "Rotate the MCP access token with an overlap window.")
    .option("--rollback", "Restore the previous healthy Worker release.")
    .action(async (options: OutputCommandOptions & { dryRun?: boolean; repair?: boolean; rotateToken?: boolean; rotateKey?: boolean; rollback?: boolean }) => {
      const dryRun = Boolean(options.dryRun || program.opts().dryRun);
      if (!dryRun && !await confirm(
        { summary: [ONBOARDING_COPY.introduction, "", ONBOARDING_COPY.credentials].join("\n") },
        {
          yes: Boolean(program.opts().yes),
          dryRun: false,
          interactive: human(),
        },
      )) return;
      const result = await getMcpService().deploy({
        dryRun,
        repair: Boolean(options.repair),
        rotateToken: Boolean(options.rotateToken),
        rotateKey: Boolean(options.rotateKey),
        rollback: Boolean(options.rollback),
        yes: Boolean(program.opts().yes),
      });
      await outputMcpResult(runtime, result, options);
    });

  addOutputOptions(mcp.command("status").description("Show local and remote Moodle MCP readiness."))
    .option("--verbose", "Include sanitized deployment diagnostics.")
    .option("--logs", "Include sanitized recent Worker logs.")
    .action(async (options: OutputCommandOptions & { verbose?: boolean; logs?: boolean }) => {
      const result = await getMcpService().status({
        verbose: Boolean(options.verbose || program.opts().verbose),
        logs: Boolean(options.logs),
      });
      await outputMcpResult(runtime, result, options);
    });

  addOutputOptions(mutating(mcp.command("login").description("Acquire and upload a fresh Moodle session."))).action(
    async (options: OutputCommandOptions) => {
      await outputMcpResult(runtime, await getMcpService().login(), options);
    },
  );

  addOutputOptions(mutating(mcp.command("connect").description("Connect a supported MCP client.").argument("[client]", "Codex, Claude, VS Code, or Cursor")))
    .option("--mode <mode>", "Use bridge or native remote mode.", parseMcpConnectionMode, "bridge")
    .option("--show-token", "Reveal the MCP token once after confirmation.")
    .action(async (client: string | undefined, options: OutputCommandOptions & { mode: "bridge" | "remote"; showToken?: boolean }) => {
      if (options.showToken) {
        const tty = Boolean(stdout && "isTTY" in stdout && stdout.isTTY);
        if (!tty || outputFormat(options, stdout) !== "table") {
          throw new UsageError("--show-token requires human output on an interactive TTY.");
        }
        if (!await confirm(
          { summary: "Reveal the managed MCP access token once in this terminal." },
          { yes: Boolean(program.opts().yes), dryRun: false, interactive: true },
        )) return;
      }
      const result = await getMcpService().connect({ client, mode: options.mode, showToken: Boolean(options.showToken) });
      await outputMcpResult(runtime, result, options);
    });

  addOutputOptions(mcp.command("clients").description("List pending and approved OAuth clients.")).action(async (options: OutputCommandOptions) => {
    await outputMcpResult(runtime, await getMcpService().manageClients({}), options);
  });
  addOutputOptions(mutating(mcp.command("revoke").description("Revoke an OAuth client or all OAuth access.").argument("[client-id]", "OAuth client id; omit with --all")))
    .option("--all", "Revoke every client, token, pending authorization, and pairing window.")
    .action(async (clientId: string | undefined, options: OutputCommandOptions & { all?: boolean }) => {
      if (Boolean(clientId) === Boolean(options.all)) throw new UsageError("Provide a client ID or --all.");
      await outputMcpResult(runtime, await getMcpService().manageClients({ revoke: true, clientId }), options);
    });

  addOutputOptions(mutating(mcp.command("pair").description("Open a pairing window so Claude can connect to the remote MCP server.").summary("Open a pairing window for Claude"))).action(
    async (options: OutputCommandOptions) => {
      await outputMcpResult(runtime, await getMcpService().pair(), options);
    },
  );

  addOutputOptions(mutating(mcp.command("remove").description("Remove one managed Moodle MCP deployment."))).action(
    async (options: OutputCommandOptions) => {
      await outputMcpResult(runtime, await getMcpService().remove({ yes: Boolean(program.opts().yes) }), options);
    },
  );

  // stdio is the only transport, so asking for it is ceremony; the flag stays for
  // client configurations that already pass it.
  mcp.command("serve").description("Run the local Moodle MCP server over stdio.").option("--stdio", "Use JSON messages over stdio (the default).").action(
    async () => {
      await getMcpService().serveStdio();
    },
  );

  mcp.command("bridge").description("Bridge a stdio MCP client to the managed remote server.")
    .option("--profile <profile>", "Use a specific managed Moodle profile.")
    .action(async (options: { profile?: string }) => {
      await getMcpService().bridge(options.profile);
    });

  const renewal = mcp.command("renewal").description("Run the installed managed-session renewal job.");
  addOutputOptions(renewal.command("run").description("Check and renew one managed Moodle session."))
    .requiredOption("--profile <profile>", "Use a specific managed Moodle profile.")
    .action(async (options: OutputCommandOptions & { profile: string }) => {
      await outputMcpResult(runtime, await getMcpService().renew(options.profile), options);
    });

  const mcpSession = mcp.command("session").description("Advanced managed-session operations.");
  addOutputOptions(mutating(mcpSession.command("push").description("Upload a Moodle cookie from standard input.").option("--stdin", "Read the cookie from standard input.")))
    .action(async (options: OutputCommandOptions & { stdin?: boolean }) => {
      if (!options.stdin) throw new UsageError("moodle mcp session push requires --stdin.");
      await outputMcpResult(runtime, await getMcpService().pushSessionFromStdin(), options);
    });

  addOutputOptions(program.command("commands").description("Describe the complete command tree.")).action(
    async (options: OutputCommandOptions) => {
      const description = describeProgram(program);
      await runtime.output(description, () => JSON.stringify(description, null, 2), options);
    },
  );

  const skills = program.command("skills").description("Show skill metadata or delegate to the shared skills CLI.").summary("Agent skill metadata");
  skills.action(() => {
    stdout.write(`${formatSkillSummary()}\n`);
  });
  skills.command("generate").description("Regenerate the agent skill bundle from the CLI command tree.").action(() => {
    writeGeneratedSkill(program);
    stdout.write("Generated Moodle skill bundle\n");
  });
  skills.command("add").description("Install the published skill through npx skills add.").allowUnknownOption(true).action((_options, command) => installSkill(command.args));

  for (const [title, names] of Object.entries(HELP_SECTIONS)) {
    // Placed in the order the list names them: that order is the help page.
    for (const name of names) for (const command of program.commands) if (command.name() === name) helpSection(command, title);
  }
  examples(program, [
    "moodle  # today: due items, alerts and news",
    "moodle UNIT grades",
    "moodle submit UNIT \"Assignment 2\" report.pdf",
  ]);
  return program;
}

// Grouped the way `gh` does: what a person reaches for daily, then the rest, then what only an agent runs.
const HELP_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  "Core commands": ["due", "news", "find", "get", "open", "submit", "quiz", "units", "activities", "grades", "threads", "forums"],
  "Additional commands": ["user", "todo", "alerts", "overview", "download", "auth", "doctor", "completion", "uninstall"],
  "Agent commands": ["mcp", "commands", "skills"],
};

export async function runCli(argv = process.argv, io: CliIO = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  const stdout = io.stdout ?? process.stdout;
  const args = insertDefaultVerb(argv.slice(2), NOUNS);
  const ui = createUi({
    input: io.stdin ?? process.stdin,
    output: stderr as Writable,
    interactive: detectAudience({
      stdin: io.stdin ?? process.stdin,
      stdout: { isTTY: Boolean(stdout && "isTTY" in stdout && stdout.isTTY) },
      env: io.env ?? process.env,
      format: errorOutputFormat(args, stdout),
    }) === "human",
  });
  try {
    await startupUpdateNotice(args, stderr, { homeDir: io.homeDir, env: io.env });
    await parseWithPrompts(() => buildProgram({ ...io, rootArgs: args }), args, { ui, fillers: { unit: pickUnit(io, ui) } });
    return 0;
  } catch (error) {
    if (isInformationalExit(error)) {
      return 0;
    }
    const format = errorOutputFormat(args, stdout);
    const normalized = normalizeError(asNetworkError(error) ?? error);
    const reference = error instanceof ReferenceError ? error : undefined;
    const reported = reportError(asNetworkError(error) ?? error, "json");
    const envelope = JSON.parse(reported.text);
    const hint = reference?.hint || normalized.hint || ({ auth: "Run moodle auth login, or moodle doctor.", config: "Run moodle doctor to check configuration.", not_found: "Run moodle units or moodle find QUERY.", usage: "Run moodle --help or moodle commands --json.", upstream: "Run moodle doctor, then retry.", network: "Check the connection, then retry.", unexpected: "Run moodle doctor; use --verbose for request timings.", cancelled: "Retry when ready." }[normalized.code]);
    envelope.error.hint = hint;
    if (reference) { envelope.error.code = reference.code; envelope.error.message = reference.message; envelope.error.candidates = reference.candidates; envelope.exit_code = reference.code === "ambiguous" ? 2 : 4; }
    stderr.write(format === "table" ? `✗ ${String(envelope.error.message).replace(/\s+/gu, " ")}\n${hint}\n` : `${JSON.stringify(envelope)}\n`);
    return envelope.exit_code;
  }
}

/**
 * Suggest the command that clears the worst check, not a fixed pair. Telling a
 * user to run `moodle auth login` when the cookie store is unreadable sends
 * them straight back into the failure they just reported.
 */
function openInBrowser(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open", [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Could not open the browser.")));
  });
}

function doctorNextSteps(checks: ReadonlyArray<{ name: string; status: string }>): string[] {
  const failing = new Set(checks.filter(c => c.status !== "pass").map(c => c.name));
  const steps: string[] = [];
  if (failing.has("browser")) steps.push("grant Full Disk Access, then rerun moodle doctor");
  else if (failing.has("session")) steps.push("moodle auth login");
  if (failing.has("sqlite")) steps.push("install Node 22.13+ or Bun");
  if (failing.has("config")) steps.push("moodle units");
  if (failing.has("job")) steps.push("moodle auth keepalive install");
  return steps.length ? steps : ["moodle todo", "moodle mcp status"];
}

async function dispatchUrl(runtime: Runtime, target: string, options: OutputCommandOptions): Promise<void> {
  const client = await runtime.getClient();
  const resolved = await resolveTopLevelUrl(client.baseUrl, target, (url) => client.resolveCourseIdForUrl(url));
  const [first] = resolved.args ?? [];
  if (!first) {
    throw new UsageError("Unsupported Moodle URL.");
  }
  const service = createIntentService(createMoodleGateway(client));
  let result: Record<string, unknown>;
  switch (resolved.commandName) {
    case "assign": case "quiz": case "resource": case "link": case "page": case "folder": {
      const loaders = { assign: () => client.getAssignment(Number(first)), quiz: () => client.getQuiz(Number(first)), resource: () => client.getResource(Number(first)), link: () => client.getLink(Number(first)), page: () => client.getPage(Number(first)), folder: () => client.getFolder(Number(first)) };
      result = { item: activitySchema.parse(stripEmpty(itemRow({ ...await loaders[resolved.commandName](), type: resolved.commandName }))) };
      break;
    }
    case "course": result = await service.run("unit", { unit: Number(first) }); break;
    case "grades": result = await service.run("grades", { unit: Number(first) }); break;
    case "forum:discussion": {
      result = await service.run("thread", { discussion_id: Number(first) });
      const hash = resolved.args?.[1];
      if (hash?.startsWith("#p")) {
        const discussion = await client.getForumDiscussion(Number(first));
        const posts = discussion.posts.filter(p => p.id === Number(hash.slice(2)));
        result = stripEmpty({ thread: { id: discussion.id, name: discussion.subject, unit_id: discussion.course_id, forum_id: discussion.forum_id, url: discussion.url, posts: posts.map(p => postRow(p, discussion.subject)), posts_total: posts.length, offset: 0 } }) as Record<string, unknown>;
      }
      break;
    }
    case "forum:discussions": {
      const refs = await client.getForumDiscussionRefs(Number(first));
      result = stripEmpty({ threads: refs.slice(0, 50).map(t => ({ id: t.id, name: t.subject })), total: refs.length }) as Record<string, unknown>;
      await runtime.output(result, () => formatForumDiscussionRefs(Number(first), refs.slice(0, 50)), options); return;
    }
    default: throw new UsageError("Unsupported Moodle URL.");
  }
  await runtime.output(result, () => runtime.screen(result, options), options);
}

function addForumSearchCommand(command: Command, runtime: Runtime, defaultLimit: number): void {
  addOutputOptions(command.argument("<query>", "Search query"))
    .option("--unit <unit>", "Restrict to a unit code, name, id or URL.")
    .option("--course <course>", "Restrict to a course ID or unique course name match.")
    .option("--forum <forum>", "Restrict to a forum ID or forum URL.")
    .option("--titles-only", "Only search discussion titles.")
    .option("--unread-only", "Only include unread matches.")
    .option("--recent", "Sort matches by newest activity.")
    .option("--limit-forums <number>", "Maximum number of forums to scan.", parsePositiveInt)
    .option("--limit-discussions <number>", "Maximum number of discussions per forum.", parsePositiveInt)
    .option("--limit <number>", "Maximum number of matches.", parsePositiveInt, defaultLimit)
    .action(async (query: string, options: OutputCommandOptions & { course?: string; unit?: string; forum?: string; titlesOnly?: boolean; unreadOnly?: boolean; recent?: boolean; limitForums?: number; limitDiscussions?: number; limit: number }) => {
      const client = await runtime.getClient();
      const courseId = options.unit || options.course ? await client.resolveCourseReference((options.unit || options.course)!) : undefined;
      const forumCmid = options.forum
        ? await parseForumReference(options.forum, (discussionId) => client.getForumViewCmid(discussionId))
        : undefined;
      const result = await createIntentService(createMoodleGateway(client)).run("search_forums", { query, courseId, forumId: forumCmid, limit: runtime.count("limit", options.limit), includePostText: true, titlesOnly: options.titlesOnly, unreadOnly: options.unreadOnly, sortBy: options.recent ? "recent" : "relevance", maxForums: options.limitForums, maxDiscussionsPerForum: options.limitDiscussions });
      await runtime.output(result, () => runtime.screen(result, options), options);
    });
}

// Accepted after every command, but the root page already lists them as global options;
// repeating the five on each page buried the flags that matter.
function addOutputOptions(command: Command): Command {
  for (const [flags, description] of [
    ["--pretty", "Indent JSON output."],
    ["--json", "Output as JSON."],
    ["--yaml", "Output as YAML."],
    ["--table", "Force human output."],
    ["--fields <fields>", "Keep only listed top-level fields in structured output."],
  ]) command.addOption(command.createOption(flags, description).hideHelp());
  return command;
}

function outputFormat(options: OutputCommandOptions, stdout: CliIO["stdout"]): OutputFormat {
  return resolveFormat(options, Boolean(stdout && "isTTY" in stdout && stdout.isTTY));
}

// What is sent and where it lands are the two facts to check before saying yes, so each gets its own role and line.
// Shown before every quiz write and in `moodle quiz --help`; the person must say yes to it.
const QUIZ_NOTICE = [
  "moodle quiz is beta: it replays the browser's quiz forms, and a Moodle update can break it without warning.",
  "Academic integrity: answers you send are your own submission under your institution's rules. Only use this",
  "where the quiz allows it, and check the attempt in a browser before you finish.",
];

// Two spellings appear in Moodle pages: a form field (name="sesskey" value="...") and a script or URL value.
export function redactSesskey(html: string): string {
  return html
    .replace(/(name="sesskey"[^>]*?value=")[^"]+/gu, "$1REDACTED")
    .replace(/(["']?sesskey["']?\s*[:=]\s*["']?)[A-Za-z0-9]{8,}/gu, "$1REDACTED");
}

function submissionSummary(plan: SubmissionReceipt, final: boolean, theme: Theme): string {
  const destination = `${theme.target(plan.name)}${plan.unit_id ? theme.dim(`  unit ${plan.unit_id}`) : ""}`;
  const lines = plan.uploads.length
    ? [`${theme.dim("Upload")}  ${theme.subject(plan.uploads.map(file => file.name).join(", "))}`, `${theme.dim("    to")}  ${destination}`]
    : [`${theme.dim("Submit")}  ${destination}`, `${theme.dim("      ")}  ${theme.subject("the files already there")} for grading`];
  if (plan.removed.length) lines.push(`${theme.dim("Remove")}  ${theme.tone("danger", plan.removed.join(", "))} ${theme.dim("first")}`);
  if (plan.statement) lines.push(`${theme.dim(" Agree")}  "${plan.statement}"`);
  lines.push(final
    ? theme.tone("warning", "Then submit for grading. Moodle does not allow undoing this.")
    : theme.dim("Moodle keeps a draft where the assignment allows drafts; otherwise it submits at once."));
  return lines.join("\n");
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError("Expected a positive integer.");
  }
  return parsed;
}

function parseMcpConnectionMode(value: string): "bridge" | "remote" {
  if (value === "bridge" || value === "remote") return value;
  throw new UsageError("MCP connection mode must be 'bridge' or 'remote'.");
}

async function outputMcpResult(runtime: Runtime, result: McpCommandOutput, options: OutputCommandOptions): Promise<void> {
  await runtime.output(result.data, () => (result.next?.length ? `${result.text}\n\n${tryLines(result.next)}` : result.text), options);
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

// A person who typed `moodle activities` is shown their units rather than a usage error.
function pickUnit(io: CliIO, ui: Ui): ArgumentFiller {
  return async () => {
    const spin = ui.spinner();
    spin.start("Loading your units");
    try {
      return await selectUnit(spin);
    } catch (error) {
      // Otherwise the spinner keeps drawing over the session error.
      spin.stop("Could not load your units");
      throw error;
    }
  };

  async function selectUnit(spin: ReturnType<Ui["spinner"]>): Promise<string> {
    const { baseUrl } = await loadConfig({ env: io.env, cwd: io.cwd, homeDir: io.homeDir, stdin: io.stdin, stderr: (io.stderr ?? process.stderr) as NodeJS.WritableStream, fetch: io.fetchImpl });
    const client = await createMoodleClient(baseUrl, { env: io.env, fetchImpl: io.fetchImpl, homeDir: io.homeDir });
    const courses = await client.getCourses();
    spin.stop(`${courses.length} units`);
    return ui.select("Which unit?", courses.map(course => ({ value: String(course.id), label: course.fullname, ...(course.shortname ? { hint: course.shortname } : {}) })));
  }
}

function parseRootOutputOptions(args: string[]): OutputCommandOptions {
  const fieldsIndex = args.findIndex((arg) => arg === "--fields" || arg.startsWith("--fields="));
  const fieldsArg = fieldsIndex >= 0 ? args[fieldsIndex] : "";
  const fields = fieldsArg.startsWith("--fields=") ? fieldsArg.slice("--fields=".length) : fieldsIndex >= 0 ? args[fieldsIndex + 1] : undefined;
  if (fieldsIndex >= 0 && (!fields || fields.startsWith("--"))) {
    throw new UsageError("--fields requires a value.");
  }
  return {
    pretty: args.includes("--pretty"),
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

function pathsReferToSameFile(moduleUrl: string, executable: string | undefined): boolean {
  if (!executable) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(executable);
  } catch {
    return false;
  }
}

const isMain = (import.meta as ImportMeta & { main?: boolean }).main === true || pathsReferToSameFile(import.meta.url, process.argv[1]);
if (isMain) {
  runCli().then((code) => {
    // A command that ran fine but reported a failure (doctor) sets its own code.
    process.exitCode = code || process.exitCode;
  });
}
