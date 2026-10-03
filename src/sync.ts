import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { HTMLElement } from "node-html-parser";

import type { MoodleClient } from "./client.js";
import { chooseUpstreamFilename, isHtmlWrapper, looksLikeLoginPage, publicUrl, resourceLinks } from "./download.js";
import { CliError, ConfigError, NotFoundError } from "./errors.js";
import type { Activity, Course, FileEntry, Section } from "./models.js";
import { parseResourceHtml, parseSavedDocumentHtml } from "./scraper.js";
import { RequestFailed } from "./session-fetch.js";

// `moodle sync` keeps one local folder per unit in step with Moodle. Each unit folder holds
// a manifest recording what every file was when it was last written; that record is what
// lets a rerun ask Moodle "has this changed?" (usually answered 304, no body) and tell a
// file you edited apart from one you only read.

export const MANIFEST_NAME = ".moodle-sync.json";
const SYNC_TYPES = new Set(["resource", "folder", "assign", "page", "book"]);
const WORKERS = 4;
const ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
// A saved page carries its images inline; one larger than this stays a link to Moodle.
const INLINE_IMAGE_LIMIT = 5 * 1024 * 1024;

export interface SyncChange {
  /** "conflict": Moodle changed a file you had edited; yours is untouched and the new one sits beside it. */
  status: "new" | "updated" | "conflict" | "removed";
  path: string;
  bytes?: number;
  /** For a conflict, your edited copy. */
  edited?: string;
}

export interface SyncProblem {
  item: string;
  message: string;
}

export interface SyncUnitResult {
  unit_id: number;
  unit: string;
  directory: string;
  changes: SyncChange[];
  unchanged: number;
  problems: SyncProblem[];
}

export interface SyncResult {
  dry_run: boolean;
  units: SyncUnitResult[];
}

export interface SyncOptions {
  /** Folder holding one subfolder per unit. */
  root: string;
  dryRun?: boolean;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

interface ManifestFile {
  /** Relative to the unit folder, "/"-separated. */
  path: string;
  /** Where Moodle's name would put it; differs from path after a "(2)" or a conflict sidestep. */
  name?: string;
  /** The URL asked again next time. For a file it is the file itself, so a rerun logs no views. */
  url: string;
  sha1: string;
  size: number;
  etag?: string;
  last_modified?: string;
  /** A page or book has no validators; the hash of what it shows stands in for them. */
  content_sha1?: string;
}

interface Manifest {
  version: 1;
  site: string;
  unit_id: number;
  files: Record<string, ManifestFile>;
}

interface SyncItem {
  /** Stable across runs: "cm:ID" for a resource, "cm:ID/<stored path>" for a file inside an activity. */
  key: string;
  label: string;
  url: string;
  dir: string;
  name?: string;
  /** A resource whose file may have been replaced under a new name, found again through its page. */
  resourceId?: number;
  /** A page or book, saved as one HTML file rather than downloaded. */
  document?: boolean;
}

interface UnitRun {
  client: MoodleClient;
  directory: string;
  manifest: Manifest;
  dryRun: boolean;
  signal?: AbortSignal;
  today: string;
  /** Lower-cased relative paths already spoken for; macOS and Windows ignore case. */
  claimed: Set<string>;
  seen: Set<string>;
  failedSources: Set<string>;
  result: SyncUnitResult;
}

export async function syncUnits(client: MoodleClient, courses: readonly Course[], options: SyncOptions): Promise<SyncResult> {
  const root = path.resolve(options.root);
  const units: SyncUnitResult[] = [];
  for (const course of courses) {
    throwIfCancelled(options.signal);
    units.push(await syncUnit(client, course, root, options));
  }
  return { dry_run: Boolean(options.dryRun), units };
}

async function syncUnit(client: MoodleClient, course: Course, root: string, options: SyncOptions): Promise<SyncUnitResult> {
  const label = course.shortname || course.fullname || String(course.id);
  const site = new URL(client.baseUrl).origin;
  const directory = await unitDirectory(root, course, site);
  const manifest = await readManifest(directory, course.id, site);
  const run: UnitRun = {
    client,
    directory,
    manifest,
    dryRun: Boolean(options.dryRun),
    signal: options.signal,
    today: localDate(options.now?.() ?? new Date()),
    claimed: new Set(Object.values(manifest.files).map((file) => file.path.toLowerCase())),
    seen: new Set(),
    failedSources: new Set(),
    result: { unit_id: course.id, unit: label, directory, changes: [], unchanged: 0, problems: [] },
  };

  options.onProgress?.(`Reading ${label}`);
  let sections: Section[];
  try {
    sections = await client.getCourseContents(course.id);
  } catch (error) {
    rethrowFatal(error);
    // One unreadable unit costs only that unit; its folder and manifest stay as they were.
    run.result.problems.push({ item: label, message: problemMessage(error) });
    return run.result;
  }
  const dirs = sectionDirectories(sections);
  const activities = syncableActivities(sections);
  let done = 0;
  try {
    await eachLimit(activities, WORKERS, async ({ activity, sectionId }) => {
      throwIfCancelled(options.signal);
      let items: SyncItem[] = [];
      try {
        items = await listActivity(run, activity, dirs.get(sectionId) ?? "");
      } catch (error) {
        rethrowFatal(error);
        run.failedSources.add(`cm:${activity.id}`);
        run.result.problems.push({ item: activity.name, message: problemMessage(error) });
      }
      for (const item of items) {
        try {
          await syncItem(run, item);
        } catch (error) {
          rethrowFatal(error);
          run.result.problems.push({ item: item.name || item.label, message: problemMessage(error) });
        }
      }
      options.onProgress?.(`Syncing ${label} · ${++done}/${activities.length}`);
    });
  } catch (error) {
    // Files already replaced must be on record, or the next run takes them for your edits.
    await saveManifest(run).catch(() => undefined);
    throw error;
  }

  for (const [key, file] of Object.entries(manifest.files)) {
    if (run.seen.has(key) || run.failedSources.has(key.split("/")[0])) continue;
    // Gone from Moodle, or no longer visible to you. The local copy is yours to keep.
    const local = path.join(directory, file.path);
    if (await exists(local)) run.result.changes.push({ status: "removed", path: local });
    if (!run.dryRun) delete manifest.files[key];
  }
  // Workers finish in any order; the report reads in folder order.
  run.result.changes.sort((a, b) => a.path.localeCompare(b.path));
  await saveManifest(run);
  return run.result;
}

// A shortcut placed in another section ("shadow") points at an activity that lives
// elsewhere; the real one is synced where it lives, once.
function syncableActivities(sections: readonly Section[]): Array<{ activity: Activity; sectionId: number }> {
  const seen = new Set<number>();
  const rows: Array<{ activity: Activity; sectionId: number }> = [];
  for (const section of sections) {
    for (const activity of section.activities) {
      if (!SYNC_TYPES.has(activity.modname) || !activity.visible || seen.has(activity.id)) continue;
      seen.add(activity.id);
      rows.push({ activity, sectionId: section.id });
    }
  }
  return rows;
}

// Mirrors the page: a nested section ("Week 5" › "Real-time") becomes a nested folder.
export function sectionDirectories(sections: readonly Section[]): Map<number, string> {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const dirs = new Map<number, string>();
  for (const section of sections) {
    const parts: string[] = [];
    for (let current: Section | undefined = section, depth = 0; current && depth < 10; depth++) {
      parts.unshift(pathSegment(current.name || `Section ${current.section}`));
      current = current.parent ? byId.get(current.parent) : undefined;
    }
    dirs.set(section.id, parts.join("/"));
  }
  return dirs;
}

async function listActivity(run: UnitRun, activity: Activity, sectionDir: string): Promise<SyncItem[]> {
  const source = `cm:${activity.id}`;
  const base = run.client.baseUrl.replace(/\/$/u, "");
  if (activity.modname === "page" || activity.modname === "book") {
    // The print view holds every chapter of a book on one page.
    const url = activity.modname === "page" ? `${base}/mod/page/view.php?id=${activity.id}` : `${base}/mod/book/tool/print/index.php?id=${activity.id}`;
    return [{ key: source, label: activity.name, url, dir: sectionDir, name: `${activity.name}.html`, document: true }];
  }
  if (activity.modname === "resource") {
    const known = run.manifest.files[source];
    const url = known?.url ?? await resourceFileUrl(run.client, activity.id);
    return [{ key: source, label: activity.name, url, dir: sectionDir, resourceId: activity.id }];
  }
  const detail = activity.modname === "folder" ? await run.client.getFolder(activity.id) : await run.client.getAssignment(activity.id);
  const dir = joinRelative(sectionDir, pathSegment(activity.name));
  return detail.file_entries.map((entry: FileEntry) => {
    const stored = storedPath(entry.url);
    // A folder keeps its own subfolders; anything else lands flat in the activity's folder.
    const inside = stored && stored[0] === "mod_folder" ? stored.slice(2, -1).map(pathSegment) : [];
    return {
      key: `${source}/${stored ? stored.join("/") : entry.name}`,
      label: activity.name,
      url: entry.url,
      dir: joinRelative(dir, ...inside),
      name: entry.name,
    };
  });
}

// The resource page shown with forceview names the stored file, whatever the display
// setting. That URL is what the manifest keeps, so later runs skip the page (and the
// view Moodle logs for it). A page that names no file falls back to the redirect.
async function resourceFileUrl(client: MoodleClient, id: number): Promise<string> {
  const base = client.baseUrl.replace(/\/$/u, "");
  const response = await client.requestAbsolute(`${base}/mod/resource/view.php?id=${id}&forceview=1`);
  if (!isHtmlWrapper(response)) {
    await response.body?.cancel().catch(() => undefined);
    return `${base}/mod/resource/view.php?id=${id}&redirect=1`;
  }
  const html = await response.text();
  if (looksLikeLoginPage(html)) throw new CliError("auth", "Moodle returned a login page instead of a resource.", "Run `moodle auth login`.");
  const target = parseResourceHtml(html, id, base).target_url;
  return target && storedPath(target) ? target : `${base}/mod/resource/view.php?id=${id}&redirect=1`;
}

async function syncItem(run: UnitRun, item: SyncItem): Promise<void> {
  run.seen.add(item.key);
  if (item.document) return syncDocument(run, item);
  for (let attempt = 1; ; attempt++) {
    try {
      await syncFile(run, item);
      return;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "network" || attempt === ATTEMPTS) throw error;
      await delay(attempt * 1000, run.signal);
    }
  }
}

// Retry the whole download after a broken body; the partial temporary file is removed
// before this function is called again, and no manifest is advanced until it completes.
async function syncFile(run: UnitRun, item: SyncItem): Promise<void> {
  const known = run.manifest.files[item.key];
  let url = item.url;
  let response = await fetchFile(run, url, known);
  if (known && item.resourceId && (response.status === 404 || response.status === 410)) {
    // The old file is gone: the resource now holds a different one.
    await response.body?.cancel().catch(() => undefined);
    url = await resourceFileUrl(run.client, item.resourceId);
    response = await fetchFile(run, url, undefined);
  }
  if (response.status === 304) {
    run.result.unchanged++;
    return;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CliError(response.status === 404 ? "not_found" : "upstream", `Moodle answered HTTP ${response.status}.`);
  }
  const relative = joinRelative(item.dir, safeFileName(chooseUpstreamFilename({ response, sourceUrl: url, requestUrl: url, targetName: item.name })));
  if (run.dryRun) {
    await response.body?.cancel().catch(() => undefined);
    return reportDryRun(run, item.key, relative);
  }
  const target = await prepareTarget(run, relative);
  const temporary = await streamToTemporary(response, target, run.signal);
  await settle(run, item.key, relative, temporary, {
    url,
    ...optional("etag", response.headers.get("etag")),
    ...optional("last_modified", response.headers.get("last-modified")),
  });
}

// A page or book is saved as one self-contained HTML file. Moodle sends no validators for
// either, so each run reads it again and compares what it shows with the last copy.
async function syncDocument(run: UnitRun, item: SyncItem): Promise<void> {
  const response = await requestWithRetry(run, item.url, {});
  if (!response.ok || !isHtmlWrapper(response)) {
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) throw new CliError("upstream", "Moodle answered with a file where a page was expected.");
    throw new CliError(response.status === 404 ? "not_found" : "upstream", `Moodle answered HTTP ${response.status}.`);
  }
  const html = await response.text();
  if (looksLikeLoginPage(html)) throw new CliError("auth", "Moodle returned a login page instead of a page.", "Run `moodle auth login`.");
  const content = parseSavedDocumentHtml(html, run.client.baseUrl);
  if (!content) throw new NotFoundError("The page shows nothing to save.");
  await inlineImages(run, content);
  const contentSha1 = createHash("sha1").update(content.toString()).digest("hex");
  if (run.manifest.files[item.key]?.content_sha1 === contentSha1) {
    run.result.unchanged++;
    return;
  }
  const relative = joinRelative(item.dir, safeFileName(item.name!));
  if (run.dryRun) return reportDryRun(run, item.key, relative);
  const target = await prepareTarget(run, relative);
  const temporary = await writeTemporary(standaloneHtml(item.label, item.url, content.toString()), target);
  await settle(run, item.key, relative, temporary, { url: item.url, content_sha1: contentSha1 });
}

async function reportDryRun(run: UnitRun, key: string, relative: string): Promise<void> {
  const known = run.manifest.files[key];
  const local = known ? await localState(run.directory, known) : "none";
  const status = !known ? "new" : local === "edited" ? "conflict" : "updated";
  run.result.changes.push({ status, path: path.join(run.directory, relative), ...(status === "conflict" ? { edited: path.join(run.directory, known!.path) } : {}) });
}

// The new bytes sit in a temporary file beside their destination; this decides where they
// go, and never over a copy you edited.
async function settle(run: UnitRun, key: string, relative: string, temporary: TemporaryFile, fields: Omit<ManifestFile, "path" | "name" | "sha1" | "size">): Promise<void> {
  const known = run.manifest.files[key];
  const record = { name: relative, sha1: temporary.sha1, size: temporary.bytes, ...fields };
  try {
    if (known && known.sha1 === temporary.sha1) {
      // Same bytes at a new address: Moodle bumps a revision on any settings edit.
      run.manifest.files[key] = { ...record, path: known.path };
      run.result.unchanged++;
      return;
    }
    if (!known) {
      const placed = await place(run, temporary, relative, true);
      run.manifest.files[key] = { ...record, path: placed.relative };
      if (placed.adopted) run.result.unchanged++;
      else run.result.changes.push({ status: "new", path: path.join(run.directory, placed.relative), bytes: temporary.bytes });
      return;
    }
    const local = await localState(run.directory, known);
    if (local === "edited") {
      const extension = path.extname(relative);
      const beside = `${relative.slice(0, relative.length - extension.length)} (updated ${run.today})${extension}`;
      const placed = await place(run, temporary, beside, false);
      // From here on the edited copy is yours alone; the manifest follows the new file.
      run.claimed.delete(known.path.toLowerCase());
      run.manifest.files[key] = { ...record, path: placed.relative };
      run.result.changes.push({ status: "conflict", path: path.join(run.directory, placed.relative), bytes: temporary.bytes, edited: path.join(run.directory, known.path) });
      return;
    }
    let placedPath = known.path;
    // Same upstream name: the new bytes replace the file where it already sits.
    if (relative.toLowerCase() === (known.name ?? known.path).toLowerCase()) {
      await rename(temporary.path, path.join(run.directory, known.path));
    } else {
      // The new version carries a new name; the old untouched copy goes with it.
      placedPath = (await place(run, temporary, relative, false)).relative;
      if (local === "pristine") await unlink(path.join(run.directory, known.path)).catch(() => undefined);
      run.claimed.delete(known.path.toLowerCase());
    }
    run.manifest.files[key] = { ...record, path: placedPath };
    run.result.changes.push({ status: "updated", path: path.join(run.directory, placedPath), bytes: temporary.bytes });
  } finally {
    await unlink(temporary.path).catch(() => undefined);
  }
}

async function prepareTarget(run: UnitRun, relative: string): Promise<string> {
  const target = path.join(run.directory, relative);
  await mkdir(path.dirname(target), { recursive: true }).catch(() => {
    throw new ConfigError(`Cannot create local directory '${path.dirname(target)}'.`);
  });
  return target;
}

// Images Moodle serves only to a signed-in browser are embedded, so the saved page reads
// the same offline. One that fails or is too large stays a link.
async function inlineImages(run: UnitRun, content: HTMLElement): Promise<void> {
  const origin = new URL(run.client.baseUrl).origin;
  for (const image of content.querySelectorAll("img[src]")) {
    const src = image.getAttribute("src") ?? "";
    if (!src.startsWith(`${origin}/`) || !src.includes("/pluginfile.php/")) continue;
    try {
      const response = await requestWithRetry(run, src, {});
      const type = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
      if (!response.ok || !type.startsWith("image/") || Number(response.headers.get("content-length")) > INLINE_IMAGE_LIMIT) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length <= INLINE_IMAGE_LIMIT) image.setAttribute("src", `data:${type};base64,${bytes.toString("base64")}`);
    } catch (error) {
      rethrowFatal(error);
    }
  }
}

function standaloneHtml(title: string, source: string, content: string): string {
  const url = escapeHtml(publicUrl(source));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.6 system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; }
img, video { max-width: 100%; height: auto; }
table { border-collapse: collapse; }
td, th { border: 1px solid #ccc; padding: 0.25rem 0.5rem; }
.moodle-source { color: #666; font-size: 0.875rem; }
</style>
</head>
<body>
<p class="moodle-source">Saved from <a href="${url}">${url}</a></p>
${content}
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
}

// Asks for a file conditionally when an earlier run saw it, so an unchanged file costs a
// 304 and no body. Transient upstream failures get two more tries.
async function fetchFile(run: UnitRun, url: string, known: ManifestFile | undefined): Promise<Response> {
  const headers: Record<string, string> = {};
  if (known?.etag) headers["if-none-match"] = known.etag;
  if (known?.last_modified) headers["if-modified-since"] = known.last_modified;
  const response = await requestWithRetry(run, url, headers);
  if (!response.ok || !url.includes("/mod/resource/view.php") || !isHtmlWrapper(response)) return response;
  // Only the redirect fallback can land on a page instead of the file.
  const html = await response.text();
  if (looksLikeLoginPage(html)) throw new CliError("auth", "Moodle returned a login page instead of a file.", "Run `moodle auth login`.");
  const [link, ...more] = resourceLinks(html, response.url || url);
  if (!link || more.length) throw new NotFoundError("The resource page does not name one file.");
  return requestWithRetry(run, link.url, headers);
}

async function requestWithRetry(run: UnitRun, url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    throwIfCancelled(run.signal);
    try {
      const response = await run.client.requestAbsolute(url, { headers, signal: run.signal }, { allowErrorStatus: true });
      if (!RETRY_STATUSES.has(response.status) || attempt === ATTEMPTS) return response;
      await response.body?.cancel().catch(() => undefined);
      await delay(retryAfter(response) ?? attempt * 1000, run.signal);
    } catch (error) {
      if (!(error instanceof RequestFailed) || attempt === ATTEMPTS) throw error;
      await delay(attempt * 1000, run.signal);
    }
  }
}

function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : undefined;
}

interface TemporaryFile {
  path: string;
  bytes: number;
  sha1: string;
}

function temporaryPathFor(destination: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.moodle-${randomUUID()}.tmp`);
}

async function writeTemporary(text: string, destination: string): Promise<TemporaryFile> {
  const temporaryPath = temporaryPathFor(destination);
  const bytes = Buffer.from(text);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new ConfigError(`Cannot write local file '${destination}'.`);
  }
  return { path: temporaryPath, bytes: bytes.length, sha1: createHash("sha1").update(bytes).digest("hex") };
}

async function streamToTemporary(response: Response, destination: string, signal?: AbortSignal): Promise<TemporaryFile> {
  const temporaryPath = temporaryPathFor(destination);
  const digest = createHash("sha1");
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    const input = response.body
      ? Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0])
      : Readable.from([]);
    await pipeline(input, counter, createWriteStream(temporaryPath, { flags: "wx" }), { signal });
    return { path: temporaryPath, bytes, sha1: digest.digest("hex") };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (signal?.aborted) throw new CliError("cancelled", "Sync cancelled.");
    if (isFileSystemError(error)) throw new ConfigError(`Cannot write local file '${destination}'.`);
    throw new CliError("network", `Download failed while reading '${publicUrl(response.url)}'.`);
  }
}

// Links the downloaded file at the first free name: "x.pdf", then "x (2).pdf". A file
// already there that no manifest records came from you, or from a run cut short before it
// saved; when its bytes match, it is adopted instead of duplicated.
async function place(run: UnitRun, temporary: TemporaryFile, relative: string, adopt: boolean): Promise<{ relative: string; adopted: boolean }> {
  const extension = path.extname(relative);
  const stem = relative.slice(0, relative.length - extension.length);
  for (let count = 1; ; count++) {
    const candidate = count === 1 ? relative : `${stem} (${count})${extension}`;
    if (run.claimed.has(candidate.toLowerCase())) continue;
    // Claimed before the first await, so two workers never pick the same name.
    run.claimed.add(candidate.toLowerCase());
    const absolute = path.join(run.directory, candidate);
    try {
      await linkOrCopy(temporary.path, absolute);
      return { relative: candidate, adopted: false };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw new ConfigError(`Cannot write local file '${absolute}'.`);
      if (adopt && await fileSha1(absolute).catch(() => "") === temporary.sha1) return { relative: candidate, adopted: true };
    }
  }
}

// A hard link is instant, but exFAT/FAT drives and some network shares have none. The copy
// still creates its file exclusively, so neither path ever replaces an existing one.
async function linkOrCopy(source: string, destination: string): Promise<void> {
  try {
    return await link(source, destination);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) throw error;
  }
  const handle = await open(destination, "wx");
  try {
    await pipeline(createReadStream(source), handle.createWriteStream());
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

async function localState(directory: string, known: ManifestFile): Promise<"pristine" | "edited" | "missing"> {
  const absolute = path.join(directory, known.path);
  try {
    const info = await stat(absolute);
    if (info.size !== known.size) return "edited";
  } catch {
    return "missing";
  }
  return await fileSha1(absolute) === known.sha1 ? "pristine" : "edited";
}

async function fileSha1(file: string): Promise<string> {
  const digest = createHash("sha1");
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

// A renamed unit folder keeps syncing: the manifest inside it, not its name, says which unit it holds.
async function unitDirectory(root: string, course: Course, site: string): Promise<string> {
  // Running inside the unit's own folder syncs that folder, not a copy nested in it.
  const own = await readJson(path.join(root, MANIFEST_NAME));
  if (own?.unit_id === course.id && own.site === site) return root;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJson(path.join(root, entry.name, MANIFEST_NAME));
    if (manifest?.unit_id === course.id && manifest.site === site) return path.join(root, entry.name);
  }
  const name = pathSegment(course.shortname || course.fullname || `Unit ${course.id}`);
  for (let count = 0; ; count++) {
    const suffix = count === 0 ? "" : ` (${course.id}${count === 1 ? "" : `-${count}`})`;
    const directory = path.join(root, name + suffix);
    // A manifest belonging to another unit or site reserves the folder's name.
    if (!await exists(path.join(directory, MANIFEST_NAME))) return directory;
  }
}

async function saveManifest(run: UnitRun): Promise<void> {
  if (run.dryRun || (!Object.keys(run.manifest.files).length && !await exists(run.directory))) return;
  await writeManifest(run.directory, run.manifest);
}

async function readManifest(directory: string, unitId: number, site: string): Promise<Manifest> {
  const data = await readJson(path.join(directory, MANIFEST_NAME));
  const files = data?.unit_id === unitId && data.site === site && data.files && typeof data.files === "object" ? data.files as Record<string, ManifestFile> : {};
  return { version: 1, site, unit_id: unitId, files };
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    return data && typeof data === "object" ? data as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function writeManifest(directory: string, manifest: Manifest): Promise<void> {
  const target = path.join(directory, MANIFEST_NAME);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new ConfigError(`Cannot write '${target}'.`);
  }
}

// "/pluginfile.php/<context>/<component>/<area>/<item>/<path…>" names one stored file.
// The context is the activity itself, and a resource or folder revision is bumped by any
// settings edit (Moodle ignores it when serving), so neither belongs in a stable key.
export function storedPath(url: string): string[] | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const marker = "/pluginfile.php/";
  const at = pathname.indexOf(marker);
  if (at < 0) return undefined;
  const parts = pathname.slice(at + marker.length).split("/").filter(Boolean).map(decodeSegment).slice(1);
  if (parts.length < 3) return undefined;
  if ((parts[0] === "mod_folder" || parts[0] === "mod_resource") && parts[1] === "content") parts.splice(2, 1);
  return parts;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Section and activity names become folder names: no separators, nothing Windows rejects,
// no leading dot that would hide the folder. Windows also refuses device names like "CON"
// or "nul.txt" whatever their extension, so those gain a suffix.
export function pathSegment(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[\\/]/gu, "-")
    .replace(/[:*?"<>|]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "");
  const short = (cleaned.length > 100 ? cleaned.slice(0, 100).trimEnd() : cleaned) || "_";
  return short.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/iu, "$1_");
}

function safeFileName(name: string): string {
  const extension = path.extname(name);
  return `${pathSegment(name.slice(0, name.length - extension.length))}${extension.replace(/[^\w.-]/gu, "")}`;
}

function joinRelative(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

function optional<K extends string>(key: K, value: string | null): Partial<Record<K, string>> {
  return value ? { [key]: value } as Record<K, string> : {};
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// The first failure stops new work, but waits for the work in flight: a file being placed
// must reach the manifest before anyone writes it.
async function eachLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      try {
        await work(items[next++]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

// A lost session or a cancel ends the whole run; anything else costs one item.
function rethrowFatal(error: unknown): void {
  if (error instanceof CliError && (error.code === "auth" || error.code === "cancelled" || error.code === "config")) throw error;
}

function problemMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Errno codes from the disk side; a dropped connection surfaces with other codes.
function isFileSystemError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    && ["EACCES", "EDQUOT", "EEXIST", "EISDIR", "EMFILE", "ENAMETOOLONG", "ENFILE", "ENOENT", "ENOSPC", "ENOTDIR", "EPERM", "EROFS"].includes(error.code);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CliError("cancelled", "Sync cancelled.");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new CliError("cancelled", "Sync cancelled."));
    }, { once: true });
  });
}
