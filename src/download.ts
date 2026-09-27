import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { parse } from "node-html-parser";

import type { MoodleClient } from "./client.js";
import { CliError, ConfigError, NotFoundError, UsageError } from "./errors.js";
import type { Resource, Section } from "./models.js";
import { parseCourseContentsHtml } from "./scraper.js";

export interface DownloadRequest {
  source: string;
  destination?: string;
  directory?: string;
  force?: boolean;
}

export interface DownloadReceipt {
  file_path: string;
  filename: string;
  bytes_written: number;
  content_type: string;
  source_url: string;
  final_url: string;
}

export interface DownloadResult {
  files: DownloadReceipt[];
  total: number;
}

interface ResolvedDownload {
  response: Response;
  sourceUrl: string;
  requestUrl: string;
  targetName?: string;
}

interface DownloadTarget {
  url: string;
  sourceUrl: string;
  name?: string;
}

// Activity types that carry files a person can save from the web page.
export const DOWNLOADABLE_TYPES = ["resource", "folder", "assign"];

const ACCEPTED_SOURCE_HINT = "Use an activity ID, a same-site activity, section or pluginfile URL, or a UNIT TASK phrase.";
const FILE_SYSTEM_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EDQUOT",
  "EEXIST",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

export async function downloadMoodleFiles(
  client: MoodleClient,
  request: DownloadRequest,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  throwIfCancelled(signal);
  const explicitDestination = request.destination ? path.resolve(request.destination) : undefined;
  if (explicitDestination && !request.force) {
    await ensureDestinationAvailable(explicitDestination);
  }

  const targets = await resolveTargets(client, request.source);
  if (explicitDestination && targets.length > 1) {
    throw new UsageError(`This source has ${targets.length} files, and --dest names exactly one.`, "Pass --to DIR to save them all.");
  }
  const directory = path.resolve(request.directory ?? process.cwd());
  if (!explicitDestination && !request.force) {
    // Known names are checked up front so a clash stops the batch before anything is written.
    for (const target of targets) {
      const name = sanitizeFilename(target.name);
      if (name) await ensureDestinationAvailable(path.join(directory, name));
    }
  }
  if (!explicitDestination && request.directory) {
    await mkdir(directory, { recursive: true }).catch(() => {
      throw new ConfigError(`Cannot create local directory '${directory}'.`);
    });
  }

  const files: DownloadReceipt[] = [];
  const used = new Set<string>();
  for (const target of targets) {
    throwIfCancelled(signal);
    const resolved = await responseOrWrapper(client, target.url, target.sourceUrl, target.name, signal);
    throwIfCancelled(signal);
    const filename = explicitDestination
      ? path.basename(explicitDestination)
      : uniqueFilename(chooseUpstreamFilename(resolved), used);
    const destination = explicitDestination ?? path.join(directory, filename);
    if (!explicitDestination && !request.force) {
      await ensureDestinationAvailable(destination);
    }
    const bytesWritten = await writeResponse(resolved.response, destination, Boolean(request.force), signal);
    files.push({
      file_path: destination,
      filename,
      bytes_written: bytesWritten,
      content_type: contentType(resolved.response),
      source_url: publicUrl(resolved.sourceUrl),
      final_url: publicUrl(resolved.response.url || resolved.requestUrl),
    });
  }
  return { files, total: files.length };
}

async function resolveTargets(client: MoodleClient, rawSource: string): Promise<DownloadTarget[]> {
  const source = rawSource.trim();
  if (/^\d+$/u.test(source)) {
    return activityTargets(client, positiveId(source, "An activity ID must be a positive integer."), true);
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new UsageError(`Unsupported download source '${source}'.`, ACCEPTED_SOURCE_HINT);
  }
  const siteUrl = new URL(client.baseUrl);
  if (url.origin !== siteUrl.origin) {
    throw new UsageError("Download URLs must use the configured Moodle site.", ACCEPTED_SOURCE_HINT);
  }
  const route = url.pathname.slice(siteUrl.pathname.replace(/\/$/u, "").length);
  if (route.startsWith("/pluginfile.php/")) {
    return [{ url: url.toString(), sourceUrl: url.toString() }];
  }
  if (route === "/mod/resource/view.php") {
    const id = positiveId(url.searchParams.get("id"), "A Moodle resource URL must include a positive ?id= value.");
    const sourceUrl = new URL(`${siteUrl.pathname.replace(/\/$/u, "")}/mod/resource/view.php?id=${id}`, siteUrl.origin).toString();
    return [{ url: url.toString(), sourceUrl }];
  }
  if (/^\/mod\/\w+\/view\.php$/u.test(route)) {
    return activityTargets(client, positiveId(url.searchParams.get("id"), "An activity URL must include a positive ?id= value."), true);
  }
  if (route === "/course/view.php") {
    return sectionTargets(client, url);
  }
  throw new UsageError(`Unsupported download source '${publicUrl(url.toString())}'.`, ACCEPTED_SOURCE_HINT);
}

// A section download is what the section's own web page shows: every file of every
// resource, folder and assignment on it. Some course formats render child sections
// inside a parent's page, so the page, not the flat section list, decides what is in it.
async function sectionTargets(client: MoodleClient, url: URL): Promise<DownloadTarget[]> {
  const courseId = positiveId(url.searchParams.get("id"), "A course URL must include a positive ?id= value.");
  const raw = url.searchParams.get("section") ?? url.hash.match(/^#section-(\d+)$/u)?.[1];
  if (raw === null || raw === undefined || !/^\d+$/u.test(raw)) {
    throw new UsageError("A course URL downloads one section; this one names none.", "Add &section=N, or run `moodle dl UNIT` to pick a section.");
  }
  const section = await sectionPage(client, courseId, Number(raw));
  const activities = downloadableActivities(section);
  const targets: DownloadTarget[] = [];
  // A few pages at a time: each activity is one Moodle request before any file moves.
  for (let index = 0; index < activities.length; index += 4) {
    const batch = await Promise.all(activities.slice(index, index + 4).map((activity) => activityTargets(client, activity.id, false)));
    targets.push(...batch.flat());
  }
  if (!targets.length) {
    throw new NotFoundError(`Section '${section.name || raw}' has no files to download.`);
  }
  return targets;
}

export async function sectionPage(client: MoodleClient, courseId: number, sectionNumber: number): Promise<Section> {
  const url = `${client.baseUrl.replace(/\/$/u, "")}/course/view.php?id=${courseId}&section=${sectionNumber}`;
  const html = await (await client.requestAbsolute(url)).text();
  if (looksLikeLoginPage(html)) {
    throw new CliError("auth", "Moodle returned a login page instead of the course section.", "Run `moodle auth login`.");
  }
  const section = parseCourseContentsHtml(html, client.baseUrl).find((candidate) => candidate.section === sectionNumber);
  if (!section) {
    throw new NotFoundError(`Section ${sectionNumber} was not found in course ${courseId}.`, "Run `moodle dl UNIT` to pick a section.");
  }
  return section;
}

export function downloadableActivities(section: Section): Section["activities"] {
  const activities = section.activities.filter((activity) => DOWNLOADABLE_TYPES.includes(activity.modname));
  return activities.filter((activity, index) => activities.findIndex((candidate) => candidate.id === activity.id) === index);
}

async function activityTargets(client: MoodleClient, activityId: number, single: boolean): Promise<DownloadTarget[]> {
  const activity = await client.getActivity(activityId);
  const sourceUrl = ("url" in activity && activity.url) || `${client.baseUrl.replace(/\/$/u, "")}/mod/${activity.type}/view.php?id=${activityId}`;
  if (!DOWNLOADABLE_TYPES.includes(activity.type)) {
    throw new UsageError(`Activity ${activityId} is '${activity.type}', which has no files to download.`, ACCEPTED_SOURCE_HINT);
  }
  const entries = "file_entries" in activity && Array.isArray(activity.file_entries) ? activity.file_entries : [];
  if (activity.type === "resource" && !entries.length) {
    // A resource whose page did not name its file still resolves through the wrapper.
    const resource = activity as Resource & { type: string };
    return [{ url: resource.target_url || sourceUrl, sourceUrl, name: resource.target_name || undefined }];
  }
  if (single && !entries.length) {
    throw new NotFoundError(`Activity ${activityId} has no files to download.`);
  }
  return entries.map((entry) => ({ url: entry.url, sourceUrl, name: entry.name || undefined }));
}

function positiveId(value: string | null, message: string): number {
  const id = Number(value);
  if (!value || !Number.isSafeInteger(id) || id < 1) {
    throw new UsageError(message, ACCEPTED_SOURCE_HINT);
  }
  return id;
}

// Two folders in one section often both hold "slides.pdf"; the second one gets a suffix
// instead of silently replacing the first.
function uniqueFilename(filename: string, used: Set<string>): string {
  const extension = path.extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  let candidate = filename;
  for (let count = 2; used.has(candidate); count++) {
    candidate = `${stem} (${count})${extension}`;
  }
  used.add(candidate);
  return candidate;
}

async function responseOrWrapper(
  client: MoodleClient,
  requestUrl: string,
  sourceUrl: string,
  targetName: string | undefined,
  signal?: AbortSignal,
): Promise<ResolvedDownload> {
  const response = await client.requestAbsolute(requestUrl, { signal });
  if (!isHtmlWrapper(response)) {
    return { response, sourceUrl, requestUrl, targetName };
  }

  const html = await response.text();
  if (looksLikeLoginPage(html)) {
    throw new CliError("auth", "Moodle returned a login page instead of the requested file.", "Run `moodle auth login`.");
  }
  const links = resourceLinks(html, requestUrl);
  if (!links.length) {
    throw new NotFoundError(`No downloadable file was found for '${publicUrl(sourceUrl)}'.`, "Inspect the activity with `moodle activities show ID --json`.");
  }
  if (links.length > 1) {
    throw new UsageError("The resource resolved to more than one downloadable file.", "Inspect file_entries and download one file URL at a time.");
  }
  const [linkEntry] = links;
  const fileResponse = await client.requestAbsolute(linkEntry.url, { signal });
  if (isHtmlWrapper(fileResponse)) {
    const body = await fileResponse.text();
    if (looksLikeLoginPage(body)) {
      throw new CliError("auth", "Moodle returned a login page instead of the requested file.", "Run `moodle auth login`.");
    }
    throw new NotFoundError(`The Moodle resource did not resolve to a file for '${publicUrl(sourceUrl)}'.`);
  }
  return {
    response: fileResponse,
    sourceUrl,
    requestUrl: linkEntry.url,
    targetName: targetName || linkEntry.name,
  };
}

function resourceLinks(html: string, baseUrl: string): Array<{ name: string; url: string }> {
  const root = parse(html);
  const entries = root
    .querySelectorAll(".resourceworkaround a[href], .resourcecontent a[href], a.resourceworkaround[href]")
    .map((linkNode) => ({
      name: linkNode.textContent.trim(),
      url: new URL(linkNode.getAttribute("href") ?? "", baseUrl).toString(),
    }))
    .filter((entry) => entry.url !== baseUrl);
  return entries.filter((entry, index) => entries.findIndex((candidate) => candidate.url === entry.url) === index);
}

function isHtmlWrapper(response: Response): boolean {
  const disposition = response.headers.get("content-disposition") ?? "";
  if (/\battachment\b/iu.test(disposition)) {
    return false;
  }
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  return type.includes("text/html") || type.includes("application/xhtml+xml");
}

function looksLikeLoginPage(html: string): boolean {
  const root = parse(html);
  return root.querySelector('form[action*="/login/"], input[name="password"], #page-login-index') !== null
    || /<title>\s*(?:log in|login)/iu.test(html);
}

function chooseUpstreamFilename(resolved: ResolvedDownload): string {
  const candidates = [
    contentDispositionFilename(resolved.response.headers.get("content-disposition")),
    resolved.targetName,
    urlFilename(resolved.response.url || resolved.requestUrl),
  ];
  for (const candidate of candidates) {
    const filename = sanitizeFilename(candidate);
    if (filename) {
      return filename;
    }
  }
  throw new NotFoundError("Moodle did not provide a safe filename.", "Pass an exact local file path with --dest.");
}

function contentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const extended = value.match(/filename\*\s*=\s*([^;]+)/iu)?.[1]?.trim().replace(/^"|"$/gu, "");
  if (extended) {
    const encoded = extended.replace(/^[^']*'[^']*'/u, "");
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  const quoted = value.match(/filename\s*=\s*"((?:\\.|[^"])*)"/iu)?.[1];
  if (quoted !== undefined) {
    return quoted.replace(/\\([\\"])/gu, "$1");
  }
  return value.match(/filename\s*=\s*([^;]+)/iu)?.[1]?.trim();
}

function urlFilename(value: string): string | undefined {
  try {
    const pathname = new URL(value).pathname;
    const encoded = pathname.slice(pathname.lastIndexOf("/") + 1);
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  } catch {
    return undefined;
  }
}

function sanitizeFilename(value: string | undefined): string | undefined {
  const basename = value?.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return basename && basename !== "." && basename !== ".." ? basename : undefined;
}

async function ensureDestinationAvailable(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw new ConfigError(`Cannot inspect local destination '${destination}'.`);
  }
  throw new UsageError(`Destination already exists: ${destination}`, "Choose another --dest path or pass --force to replace this exact file.");
}

async function writeResponse(response: Response, destination: string, force: boolean, signal?: AbortSignal): Promise<number> {
  const temporaryPath = path.join(path.dirname(destination), `.${path.basename(destination)}.moodle-${randomUUID()}.tmp`);
  let bytesWritten = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    throwIfCancelled(signal);
    const input = response.body
      ? Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0])
      : Readable.from([]);
    await pipeline(input, counter, createWriteStream(temporaryPath, { flags: "wx" }), { signal });
    if (force) {
      await rename(temporaryPath, destination);
    } else {
      try {
        await link(temporaryPath, destination);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw new UsageError(`Destination already exists: ${destination}`, "Choose another --dest path or pass --force to replace this exact file.");
        }
        throw error;
      }
      await unlink(temporaryPath);
    }
    return bytesWritten;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new CliError("cancelled", "Download cancelled.");
    }
    if (error instanceof CliError) throw error;
    if (isFileSystemError(error)) {
      throw new ConfigError(`Cannot write local destination '${destination}'.`);
    }
    throw new CliError("network", `Download failed while reading '${publicUrl(response.url)}'.`);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function contentType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";", 1)[0].trim();
}

function publicUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key !== "id" && key !== "forcedownload" && key !== "download") {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return "the requested Moodle file";
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CliError("cancelled", "Download cancelled.");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isFileSystemError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && FILE_SYSTEM_ERROR_CODES.has(error.code);
}
