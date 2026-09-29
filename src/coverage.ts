import { DASHBOARD_PATH, FUNC_GET_SITE_INFO } from "./constants.js";
import type { Intent } from "./intent-contract.js";
import { createIntentService, type IntentService } from "./intents.js";
import { createMoodleGateway, MAX_MCP_FILE_BYTES, type MoodleGateway } from "./mcp/gateway.js";
import { readMobilePublicConfig } from "./mobile-login-core.js";
import type { Activity } from "./models.js";
import type { MoodleClientCore } from "./moodle-client-core.js";
import { parseSiteTheme } from "./scraper.js";

export type CoverageStatus = "ok" | "fallback" | "partial" | "empty" | "fail" | "skip" | "untested";

export interface CoverageCheck {
  /** The intent under test: the MCP tool of the same name and the CLI command behind it. */
  name: Intent;
  /** The activity type an item check read. */
  target?: string;
  status: CoverageStatus;
  detail: string;
  /** Services the site refused while this check ran; the command went around them. */
  disabled?: string[];
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
}

type Row = Record<string, unknown>;
type Outcome = { detail: string; status?: "empty" | "partial" };

// One of each kind the item reader parses on its own, plus forums, which list threads.
const ITEM_TYPES = ["assign", "quiz", "resource", "url", "page", "folder", "forum"] as const;
// A few units usually hold one of each kind; reading every unit would turn a check into a crawl.
const SAMPLE_UNITS = 4;
// The field each reader exists to find. A page read without it was fetched but not understood,
// which on another school's theme is the usual way a scraper breaks.
const ITEM_CORE: Partial<Record<string, (item: Row) => unknown>> = {
  assign: item => item.submission_status,
  resource: item => rows(item, "files").length,
  folder: item => rows(item, "files").length,
  url: item => item.target_url,
  page: item => item.content_text,
};

/**
 * Runs every read-only intent once against the live site, in the order a person meets
 * them, and yields each result as soon as it is known. Samples come from the account's
 * own units, so nothing is created and no write path is exercised.
 */
export async function* checkCoverage(service: IntentService, gateway: MoodleGateway, options: CoverageOptions = {}): AsyncGenerator<CoverageCheck> {
  const take = options.takeDisabled ?? (() => []);
  const now = options.now ?? Date.now;
  const run = async (name: Intent, args: Row, describe: (result: Row) => Outcome, extra: { target?: string; accept?: (error: unknown) => Outcome | undefined } = {}): Promise<{ check: CoverageCheck; result?: Row }> => {
    options.onStart?.(name, extra.target);
    // Anything refused while sampling between checks belongs to no check.
    take();
    const started = now();
    const base = { name, ...(extra.target ? { target: extra.target } : {}) };
    const finish = (status: CoverageStatus, detail: string, more: Partial<CoverageCheck> = {}): CoverageCheck => {
      const disabled = [...new Set(take())].sort();
      return { ...base, status: status === "ok" && disabled.length ? "fallback" : status, detail, ...more, ...(disabled.length ? { disabled } : {}), ms: now() - started };
    };
    try {
      const result = await service.run(name, args);
      const outcome = describe(result);
      return { result, check: finish(outcome.status ?? "ok", outcome.detail) };
    } catch (error) {
      // An expired session would fail every later check for the same reason.
      if ((error as { code?: unknown }).code === "auth") throw error;
      const accepted = extra.accept?.(error);
      if (accepted) return { check: finish(accepted.status ?? "ok", accepted.detail) };
      const code = errorCode(error);
      return { check: finish("fail", errorDetail(error), code ? { error_code: code } : {}) };
    }
  };
  const skip = (name: Intent, detail: string, target?: string): CoverageCheck => ({ name, ...(target ? { target } : {}), status: "skip", detail });
  const untested: CoverageCheck = { name: "submit", status: "untested", detail: "Not exercised: it writes to Moodle. moodle submit REF FILE plans without uploading." };

  const units = await run("units", { limit: 200 }, r => counted(num(r.total), "unit", "No enrolled units."));
  yield units.check;
  yield (await run("home", { days: 14 }, r => {
    const home = record(r.home);
    const errors = Array.isArray(home.errors) ? home.errors.map(String) : [];
    return errors.length ? { status: "partial", detail: errors.join("; ") } : { detail: `${count(rows(home, "units").length, "unit")}, ${count(num(home.total), "item")} due` };
  })).check;
  yield (await run("due", { days: 30 }, r => ({ detail: `${count(num(r.total), "item")} in 30 days` }))).check;

  const sample = sampleUnits(rows(units.result, "units"), now() / 1000);
  const primary = sample[0];
  if (!primary) {
    for (const name of ["unit", "find", "item", "attempt", "grades", "news", "thread", "search_forums", "file"] as const) yield skip(name, "No enrolled unit to check with.");
    yield untested;
    return;
  }
  yield (await run("unit", { unit: primary }, r => counted(num(r.total), "section", "The unit page showed no sections."))).check;

  const picks = new Map<string, { activity: Activity; unit: number }>();
  for (const unit of sample) {
    const sections = await gateway.getCourse({ courseId: unit }).then(detail => detail.sections, () => []);
    for (const activity of sections.flatMap(section => section.activities)) {
      if (activity.visible === false || !(ITEM_TYPES as readonly string[]).includes(activity.modname)) continue;
      const known = picks.get(activity.modname);
      // The file tool returns one file whole, so a single-file resource is the fair test.
      if (!known || (activity.modname === "resource" && !singleFile(known.activity) && singleFile(activity))) picks.set(activity.modname, { activity, unit });
    }
    if (ITEM_TYPES.every(type => picks.has(type)) && singleFile(picks.get("resource")!.activity)) break;
  }

  const first = picks.values().next().value;
  yield first
    ? (await run("find", { query: first.activity.name, unit: first.unit, limit: 5 }, r => counted(num(r.total), "match", "No match for an activity name taken from the unit."))).check
    : skip("find", "No activity in the sampled units to search for.");

  const items = new Map<string, Row>();
  for (const type of ITEM_TYPES) {
    const pick = picks.get(type);
    if (!pick) { yield skip("item", `No visible ${type} in the sampled units.`, type); continue; }
    const item = await run("item", { ref: pick.activity.id }, r => describeItem(type, r), { target: type });
    if (item.result) items.set(type, item.result);
    yield item.check;
  }

  const quiz = items.get("quiz");
  const attemptId = rows(record(quiz?.item), "attempts").map(a => num(a.id)).find(Boolean);
  yield attemptId
    ? (await run("attempt", { attempt: attemptId }, r => counted(rows(record(r.attempt), "questions").length, "question", "The review page showed no questions; the quiz may hide them."))).check
    : skip("attempt", quiz ? "The sampled quiz has no attempt to review." : "No quiz attempt in the sampled units.");

  yield (await run("grades", { unit: primary }, r => {
    const row = rows(r, "grades")[0] ?? {};
    return num(row.total) ? { detail: `${count(num(row.total), "item")}, ${num(row.graded)} graded` } : { status: "empty", detail: "No gradebook items for the checked unit; it may have none yet." };
  })).check;

  const news = await run("news", { unit: primary, limit: 1 }, r => ({ detail: count(num(r.total), "announcement") }));
  yield news.check;

  const discussion = [...rows(news.result, "news"), ...rows(items.get("forum"), "threads")].find(row => num(row.id));
  yield discussion
    ? (await run("thread", { discussion_id: num(discussion.id), limit: 1 }, r => counted(num(record(r.thread).posts_total), "post", "The discussion showed no posts."))).check
    : skip("thread", "No discussion in the sampled units to open.");

  // Any word will do: the check is whether forums can be read and searched at all.
  const query = String(discussion?.name ?? "").split(/\s+/u).find(word => word.length > 2) ?? "the";
  yield (await run("search_forums", { query, unit: picks.get("forum")?.unit ?? primary, maxForums: 2, maxDiscussionsPerForum: 5, limit: 5 }, r => ({ detail: `${count(num(r.total), "match")} in up to 2 forums` }))).check;

  const resource = picks.get("resource");
  yield resource
    ? (await run("file", { ref: resource.activity.id }, r => {
      const file = record(r.file);
      return { detail: `${String(file.mime_type || "file")}, ${formatBytes(num(file.bytes))}` };
    }, { accept: error => errorCode(error) === "MOODLE_FILE_TOO_LARGE" ? { detail: `Reachable, but larger than the ${MAX_MCP_FILE_BYTES / 1024 / 1024} MiB the file tool returns.` } : undefined })).check
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

function describeItem(type: string, result: Row): Outcome {
  const item = record(result.item);
  const files = rows(item, "files").length;
  const facts = [
    item.submission_status && "submission status",
    item.grading_status && "grading status",
    item.due && "due date",
    type === "quiz" && count(rows(item, "attempts").length, "attempt"),
    item.attempts_allowed && "attempts allowed",
    files && count(files, "file"),
    item.target_url && "target URL",
    item.content_text && "page text",
    type === "forum" && count(num(result.total), "thread"),
  ].filter((fact): fact is string => typeof fact === "string");
  const core = ITEM_CORE[type];
  if (!item.name || (core && !core(item))) return { status: "empty", detail: `The ${type} page was read, but ${item.name ? "its main content" : "the activity name"} was not found.` };
  return { detail: facts.join(", ") || "read" };
}

function counted(total: number, noun: string, empty: string): Outcome {
  return total ? { detail: count(total, noun) } : { status: "empty", detail: empty };
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : noun.endsWith("ch") ? "es" : "s"}`;
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

function singleFile(activity: Activity): boolean {
  return activity.file_entries?.length === 1;
}
