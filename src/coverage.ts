import { DASHBOARD_PATH, FUNC_GET_SITE_INFO } from "./constants.js";
import type { Intent } from "./intent-contract.js";
import { createIntentService, type IntentService } from "./intents.js";
import { createMoodleGateway, MAX_MCP_FILE_BYTES, type MoodleGateway } from "./mcp/gateway.js";
import { readMobilePublicConfig } from "./mobile-login-core.js";
import type { Activity } from "./models.js";
import type { MoodleClientCore } from "./moodle-client-core.js";
import { parseSiteTheme } from "./scraper.js";

export type CoverageStatus = "ok" | "fallback" | "partial" | "empty" | "mismatch" | "fail" | "skip" | "untested";

/** Statuses that mean a command gives a wrong or no answer on this site. */
export const COVERAGE_FAILURES: readonly CoverageStatus[] = ["mismatch", "fail"];

export interface CoverageCheck {
  /** The intent under test: the MCP tool of the same name and the CLI command behind it. */
  name: Intent;
  /** The activity type an item check read. */
  target?: string;
  status: CoverageStatus;
  detail: string;
  /** The id the check read, so the same command can be rerun by hand with --verbose. */
  ref?: number;
  /** What the answer was compared against; an ok without this only proves the command ran. */
  verified?: string[];
  /** Services the site refused while this check ran; the command went around them. */
  disabled?: string[];
  /** A transient failure was retried once and the second attempt decided the status. */
  retried?: boolean;
  error_code?: string;
  ms?: number;
}

/** Which build produced the report: a failure from an old release may already be fixed. */
export interface CoverageCli {
  version: string;
  /** The published release, or null when the registry could not be reached. */
  latest: string | null;
  runtime: string;
}

export interface CoverageSite {
  url: string;
  release?: string;
  theme?: string;
  mobile_service?: boolean;
}

export interface CoverageReport {
  cli: CoverageCli;
  site: CoverageSite;
  checks: CoverageCheck[];
  disabled_services: string[];
  summary: Partial<Record<CoverageStatus, number>>;
}

export interface CoverageOptions {
  /** Services refused since the previous call, so each check names its own fallbacks. */
  takeDisabled?: () => string[];
  onStart?: (name: Intent, target?: string) => void;
  now?: () => number;
  /** A check that runs longer fails instead of stalling the report. */
  timeoutMs?: number;
  retryDelayMs?: number;
}

type Row = Record<string, unknown>;
type Outcome = { detail: string; status?: "empty" | "partial" | "mismatch"; verified?: string[] };
type Pick = { activity: Activity; unit: number };

// One of each kind the item reader parses on its own, plus forums, which list threads.
const ITEM_TYPES = ["assign", "quiz", "resource", "url", "page", "folder", "forum"] as const;
// A few units usually hold one of each kind; reading every unit would turn a check into a crawl.
const SAMPLE_UNITS = 4;
const CHECK_TIMEOUT_MS = 120_000;
const PAGE_READERS = new Set(["assign", "quiz", "resource", "url", "page", "folder"]);
// The field each reader exists to find. A page read without it was fetched but not understood,
// which on another school's theme or language is the usual way a scraper breaks.
const ITEM_CORE: Partial<Record<string, (item: Row) => unknown>> = {
  assign: item => item.submission_status,
  resource: item => rows(item, "files").length,
  folder: item => rows(item, "files").length,
  url: item => item.target_url,
  page: item => item.content_text,
};
// Proxies, load balancers and a busy site fail a request now and then; one retry keeps that
// from being reported as the site not supporting the command.
const TRANSIENT = /\bHTTP (?:429|502|503|504)\b|did not respond within|Could not reach|ECONNRESET|socket hang up/u;

/**
 * Runs every read-only intent once against the live site, in the order a person meets
 * them, and yields each result as soon as it is known. Samples come from the account's
 * own units, so nothing is created and no write path is exercised.
 *
 * A check passes only when the answer agrees with what the site states elsewhere in
 * structured form: the unit's contents for names and files, the calendar for due dates,
 * the forum listing for searches. Where no such source exists, the check says so.
 */
export async function* checkCoverage(service: IntentService, gateway: MoodleGateway, options: CoverageOptions = {}): AsyncGenerator<CoverageCheck> {
  const take = options.takeDisabled ?? (() => []);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const run = async (name: Intent, args: Row, describe: (result: Row) => Outcome, extra: { target?: string; ref?: number; accept?: (error: unknown) => Outcome | undefined } = {}): Promise<{ check: CoverageCheck; result?: Row }> => {
    options.onStart?.(name, extra.target);
    // Anything refused while sampling between checks belongs to no check.
    take();
    const started = now();
    let retried = false;
    const finish = (outcome: Omit<Outcome, "status"> & { status?: CoverageStatus }, more: Partial<CoverageCheck> = {}): CoverageCheck => {
      const disabled = [...new Set(take())].sort();
      const status = outcome.status ?? "ok";
      return {
        name,
        ...(extra.target ? { target: extra.target } : {}),
        status: status === "ok" && disabled.length ? "fallback" : status,
        detail: outcome.detail,
        ...(extra.ref ? { ref: extra.ref } : {}),
        ...(outcome.verified?.length && (status === "ok" || status === "fallback") ? { verified: outcome.verified } : {}),
        ...more,
        ...(disabled.length ? { disabled } : {}),
        ...(retried ? { retried } : {}),
        ms: now() - started,
      };
    };
    for (;;) {
      try {
        const result = await withTimeout(service.run(name, args), timeoutMs);
        return { result, check: finish(describe(result)) };
      } catch (error) {
        // An expired session would fail every later check for the same reason.
        if ((error as { code?: unknown }).code === "auth") throw error;
        if (!retried && TRANSIENT.test(errorDetail(error))) {
          retried = true;
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          continue;
        }
        const accepted = extra.accept?.(error);
        if (accepted) return { check: finish(accepted) };
        const code = errorCode(error);
        return { check: finish({ status: "fail", detail: errorDetail(error) }, code ? { error_code: code } : {}) };
      }
    }
  };
  const skip = (name: Intent, detail: string, target?: string): CoverageCheck => ({ name, ...(target ? { target } : {}), status: "skip", detail });
  const untested: CoverageCheck = { name: "submit", status: "untested", detail: "Not exercised: it writes to Moodle. moodle submit REF FILE plans without uploading." };

  const units = await run("units", { limit: 200 }, r => counted(num(r.total), "unit", "No enrolled units."));
  yield units.check;
  const unitIds = new Set(rows(units.result, "units").map(unit => num(unit.id)));
  yield (await run("home", { days: 14 }, r => {
    const home = record(r.home);
    const errors = Array.isArray(home.errors) ? home.errors.map(String) : [];
    if (errors.length) return { status: "partial", detail: errors.join("; ") };
    const listed = rows(home, "units").map(unit => num(unit.id));
    // The dashboard and the unit list are separate reads; they must name the same units.
    // The list stops at 200 rows, so past that only the totals can be compared.
    const total = num(units.result?.total);
    const differs = listed.length !== total || (total === unitIds.size && listed.some(id => !unitIds.has(id)));
    if (units.result && differs) return { status: "mismatch", detail: `The dashboard lists ${count(listed.length, "unit")}; the unit list has ${total}.` };
    return { detail: `${count(listed.length, "unit")}, ${count(num(home.total), "item")} due`, verified: units.result ? ["unit list"] : [] };
  })).check;
  const due = await run("due", { days: 30 }, r => {
    const rowsDue = rows(r, "due");
    const nowSeconds = now() / 1000;
    // Calendar rows are structured already; one from before the window means the window
    // the command sent was ignored. Units are not compared: the calendar also covers units
    // a person has hidden from the dashboard, which the fallback unit list leaves out.
    const stray = rowsDue.filter(row => num(row.due_at) < nowSeconds - 86_400);
    if (stray.length) return { status: "mismatch", detail: `${count(stray.length, "deadline")} fall before the requested window.` };
    return { detail: `${count(num(r.total), "item")} in 30 days`, verified: rowsDue.length ? ["window"] : [] };
  });
  yield due.check;
  const deadlines = new Map(rows(due.result, "due").filter(row => num(row.activity_id)).map(row => [num(row.activity_id), num(row.due_at)]));

  const sample = sampleUnits(rows(units.result, "units"), now() / 1000);
  const primary = sample[0];
  if (!primary) {
    for (const name of ["unit", "find", "item", "attempt", "grades", "news", "thread", "search_forums", "file"] as const) yield skip(name, "No enrolled unit to check with.");
    yield untested;
    return;
  }
  yield (await run("unit", { unit: primary }, r => {
    const sections = rows(r, "sections");
    if (!sections.length) return { status: "empty", detail: "The unit page showed no sections." };
    const activities = sections.reduce((total, section) => total + num(section.activity_count), 0);
    // A course format the reader does not understand still yields section headings.
    if (!activities) return { status: "empty", detail: `${count(sections.length, "section")} but no activities in any of them.` };
    return { detail: `${count(sections.length, "section")}, ${count(activities, "activity")}` };
  }, { ref: primary })).check;

  const picks = new Map<string, Pick>();
  for (const unit of sample) {
    const sections = await gateway.getCourse({ courseId: unit }).then(detail => detail.sections, () => []);
    for (const activity of sections.flatMap(section => section.activities)) {
      // Only what the account can open: a restricted or hidden activity would fail for
      // reasons that say nothing about the command.
      if (activity.visible === false || !(ITEM_TYPES as readonly string[]).includes(activity.modname)) continue;
      const known = picks.get(activity.modname);
      // The file tool returns one file whole, so a single-file resource is the fair test,
      // and an assignment with a calendar deadline lets the page's due date be checked.
      const better = !known
        || (activity.modname === "resource" && !singleFile(known.activity) && singleFile(activity))
        || (activity.modname === "assign" && !deadlines.has(known.activity.id) && deadlines.has(activity.id));
      if (better) picks.set(activity.modname, { activity, unit });
    }
    if (ITEM_TYPES.every(type => picks.has(type)) && singleFile(picks.get("resource")!.activity)) break;
  }

  const first = picks.values().next().value;
  yield first
    ? (await run("find", { query: first.activity.name, unit: first.unit, limit: 50 }, r => {
      const found = rows(r, "results").some(row => num(row.id) === first.activity.id);
      return found
        ? { detail: `${count(num(r.total), "match")}, including the activity searched for`, verified: ["unit contents"] }
        : { status: "mismatch", detail: "Searching for an activity by its own name did not return it." };
    }, { ref: first.activity.id })).check
    : skip("find", "No activity in the sampled units to search for.");

  const items = new Map<string, Row>();
  for (const type of ITEM_TYPES) {
    const pick = picks.get(type);
    if (!pick) { yield skip("item", `No ${type} the account can open in the sampled units.`, type); continue; }
    const item = await run("item", { ref: pick.activity.id }, r => describeItem(type, r, pick.activity, deadlines.get(pick.activity.id)), { target: type, ref: pick.activity.id });
    if (item.result) items.set(type, item.result);
    yield item.check;
  }

  const quiz = items.get("quiz");
  const attemptId = rows(record(quiz?.item), "attempts").map(a => num(a.id)).find(Boolean);
  yield attemptId
    ? (await run("attempt", { attempt: attemptId }, r => {
      const questions = rows(record(r.attempt), "questions");
      if (!questions.length) return { status: "empty", detail: "The review page showed no questions; the quiz may hide them." };
      const unread = questions.filter(question => !question.text).length;
      if (unread) return { status: "empty", detail: `${count(unread, "question")} of ${questions.length} came back without text.` };
      return { detail: count(questions.length, "question") };
    }, { ref: attemptId })).check
    : skip("attempt", quiz ? "The sampled quiz has no attempt the account can review." : "No quiz attempt in the sampled units.");

  yield (await run("grades", { unit: primary }, r => {
    const row = rows(r, "grades")[0] ?? {};
    const total = num(row.total);
    if (!total) return { status: "empty", detail: "No gradebook items for the checked unit; it may have none yet." };
    if (rows(row, "items").some(item => !item.name)) return { status: "empty", detail: "Some gradebook rows came back without a name." };
    return { detail: `${count(total, "item")}, ${num(row.graded)} graded` };
  }, { ref: primary })).check;

  const news = await run("news", { unit: primary, limit: 1 }, r => ({ detail: count(num(r.total), "announcement") }), { ref: primary });
  yield news.check;

  const forum = picks.get("forum");
  const headline = rows(news.result, "news")[0];
  const topic = rows(items.get("forum"), "threads")[0];
  const discussion = headline && num(headline.id) && num(headline.forum_id)
    ? { id: num(headline.id), subject: String(headline.name ?? ""), forum: num(headline.forum_id), unit: num(headline.unit_id) || primary }
    : topic && num(topic.id) && forum
      ? { id: num(topic.id), subject: String(topic.name ?? ""), forum: forum.activity.id, unit: forum.unit }
      : undefined;
  yield discussion
    ? (await run("thread", { discussion_id: discussion.id, limit: 1 }, r => {
      const thread = record(r.thread);
      const total = num(thread.posts_total);
      if (!total) return { status: "empty", detail: "The discussion showed no posts." };
      const post = rows(thread, "posts")[0] ?? {};
      if (!post.message_text || !record(post.author).name) return { status: "empty", detail: "The first post came back without its text or author." };
      return { detail: count(total, "post"), verified: ["discussion listing"] };
    }, { ref: discussion.id })).check
    : skip("thread", "No discussion in the sampled units to open.");

  // A word from a discussion the forum is known to hold must find that discussion.
  const word = longestWord(discussion?.subject ?? "");
  yield discussion && word
    ? (await run("search_forums", { query: word, unit: discussion.unit, forumId: discussion.forum, maxForums: 1, maxDiscussionsPerForum: 50, limit: 50 }, r => rows(r, "results").some(row => num(row.discussion_id) === discussion.id)
      ? { detail: `${count(num(r.total), "match")}, including the discussion searched for`, verified: ["discussion listing"] }
      : { status: "mismatch", detail: "Searching a forum for a word from a discussion title did not find that discussion." }, { ref: discussion.forum })).check
    : skip("search_forums", "No discussion in the sampled units to search for.");

  const resource = picks.get("resource");
  yield resource
    ? (await run("file", { ref: resource.activity.id }, r => {
      const file = record(r.file);
      if (!num(file.bytes)) return { status: "empty", detail: "The file came back empty." };
      const listed = singleFile(resource.activity) ? resource.activity.file_entries![0].name : undefined;
      if (listed && !sameName(file.name, listed)) return { status: "mismatch", detail: "The downloaded file is not the one the unit lists." };
      return { detail: `${String(file.mime_type || "file")}, ${formatBytes(num(file.bytes))}`, verified: listed ? ["unit contents"] : [] };
    }, { ref: resource.activity.id, accept: error => errorCode(error) === "MOODLE_FILE_TOO_LARGE" ? { detail: `Reachable, but larger than the ${MAX_MCP_FILE_BYTES / 1024 / 1024} MiB the file tool returns.` } : undefined })).check
    : skip("file", "No file resource in the sampled units.");

  yield untested;
}

/**
 * Checks the site through a live client. It first forgets which services earlier sessions
 * found disabled, so the report says what the site does today; the calls then relearn
 * that list, which later commands use to skip dead requests.
 */
export async function coverageReport(client: MoodleClientCore, cli: CoverageCli, options: Omit<CoverageOptions, "takeDisabled"> & { fetchImpl?: typeof fetch; onSite?: (site: CoverageSite) => void; onCheck?: (check: CoverageCheck) => void } = {}): Promise<CoverageReport> {
  await client.forgetUnavailableServices();
  const seen = new Set<string>();
  let pending: string[] = [];
  const stop = client.onServiceUnavailable(name => { seen.add(name); pending.push(name); });
  try {
    const site = await siteFacts(client, options.fetchImpl);
    options.onSite?.(site);
    const gateway = createMoodleGateway(client);
    const checks: CoverageCheck[] = [];
    const takeDisabled = () => { const names = pending; pending = []; return names; };
    for await (const check of checkCoverage(createIntentService(gateway), gateway, { ...options, takeDisabled })) {
      checks.push(check);
      options.onCheck?.(check);
    }
    return { cli, site, checks, disabled_services: [...seen].sort(), summary: summarizeCoverage(checks) };
  } finally {
    stop();
  }
}

export function summarizeCoverage(checks: readonly CoverageCheck[]): Partial<Record<CoverageStatus, number>> {
  const summary: Partial<Record<CoverageStatus, number>> = {};
  for (const check of checks) summary[check.status] = (summary[check.status] ?? 0) + 1;
  return summary;
}

// The facts a maintainer needs to reproduce a report from another school: which Moodle,
// which theme the scrapers read, and whether sessions can renew without a browser.
async function siteFacts(client: MoodleClientCore, fetchImpl?: typeof fetch): Promise<CoverageSite> {
  const [info] = await client.callBatch([{ methodname: FUNC_GET_SITE_INFO }]);
  const release = info?.ok ? record(info.data).release : undefined;
  const theme = await client.requestAbsolute(`${client.baseUrl}${DASHBOARD_PATH}`).then(response => response.text()).then(parseSiteTheme, () => undefined);
  const mobile = await readMobilePublicConfig(client.baseUrl, fetchImpl);
  return {
    url: client.baseUrl,
    ...(typeof release === "string" && release ? { release } : {}),
    ...(theme ? { theme } : {}),
    ...(mobile ? { mobile_service: mobile.mobileServiceEnabled } : {}),
  };
}

// Current units first: past ones are often archived with their content trimmed.
function sampleUnits(units: readonly Row[], nowSeconds: number): number[] {
  const current = (unit: Row) => unit.hidden !== true && num(unit.start_at) <= nowSeconds && (!num(unit.end_at) || num(unit.end_at) >= nowSeconds);
  return [...units].sort((a, b) => Number(current(b)) - Number(current(a))).map(unit => num(unit.id)).filter(Boolean).slice(0, SAMPLE_UNITS);
}

function describeItem(type: string, result: Row, listed: Activity, deadline?: number): Outcome {
  const item = record(result.item);
  const files = rows(item, "files");
  if (!item.name) return { status: "empty", detail: `The ${type} page was read, but no activity name was found on it.` };
  const core = ITEM_CORE[type];
  if (core && !core(item)) return { status: "empty", detail: `The ${type} page was read, but its main content was not found.` };
  const verified: string[] = [];
  // Only a type with its own page reader can disagree with the contents; the rest are
  // described from the contents themselves. A resource that downloads at once is named
  // after its file, so only its files are compared.
  if (PAGE_READERS.has(type) && type !== "resource") {
    if (!sameName(item.name, listed.name)) return { status: "mismatch", detail: `The ${type} page names a different activity than the unit lists.` };
    verified.push("name");
  }
  const expected = (type === "resource" || type === "folder") ? (listed.file_entries ?? []).map(file => file.name) : [];
  if (expected.length) {
    const missing = expected.filter(name => !files.some(file => sameName(file.name, name)));
    if (missing.length) return { status: "mismatch", detail: `${missing.length} of ${count(expected.length, "file")} the unit lists were not found on the ${type} page.` };
    verified.push("files");
  }
  // The calendar is structured; a due date it knows and the page reader missed is a label
  // the reader did not recognise, typically another language or a renamed string.
  if (type === "assign" && deadline) {
    if (!item.due_pretty) return { status: "mismatch", detail: "The calendar has a due date the assignment page reader did not find." };
    verified.push("calendar due date");
  }
  const facts = [
    item.submission_status && "submission status",
    item.grading_status && "grading status",
    item.due_pretty && "due date",
    type === "quiz" && count(rows(item, "attempts").length, "attempt"),
    item.attempts_allowed && "attempts allowed",
    files.length && count(files.length, "file"),
    item.target_url && "target URL",
    item.content_text && "page text",
    type === "forum" && count(num(result.total), "thread"),
  ].filter((fact): fact is string => typeof fact === "string");
  return { detail: facts.join(", ") || "read", verified };
}

function counted(total: number, noun: string, empty: string): Outcome {
  return total ? { detail: count(total, noun) } : { status: "empty", detail: empty };
}

function count(value: number, noun: string): string {
  if (value === 1) return `${value} ${noun}`;
  return `${value} ${noun.endsWith("ch") ? `${noun}es` : /[^aeiou]y$/u.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KiB` : `${bytes} bytes`;
}

function errorCode(error: unknown): string | undefined {
  const { moodleErrorCode, code } = (error ?? {}) as { moodleErrorCode?: unknown; code?: unknown };
  const value = moodleErrorCode ?? code;
  return typeof value === "string" && value ? value : undefined;
}

function errorDetail(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim() || "Unknown error";
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function rows(value: unknown, key: string): Row[] {
  const list = record(value)[key];
  return Array.isArray(list) ? list.map(record) : [];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sameName(found: unknown, listed: unknown): boolean {
  const a = normalizeName(found);
  const b = normalizeName(listed);
  // Themes add prefixes and suffixes to headings ("Assignment: X", "X | Unit"), so one
  // containing the other counts; a different activity's name does not.
  return Boolean(a && b) && (a === b || a.includes(b) || b.includes(a));
}

function normalizeName(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function longestWord(text: string): string | undefined {
  return text.split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3).sort((a, b) => b.length - a.length)[0];
}

async function withTimeout<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`Timed out after ${Math.round(ms / 1000)}s.`), { code: "timeout" })), ms); });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function singleFile(activity: Activity): boolean {
  return activity.file_entries?.length === 1;
}
