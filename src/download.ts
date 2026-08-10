import { createWriteStream } from "node:fs";
import { link, lstat, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { parse } from "node-html-parser";

import type { MoodleClient } from "./client.js";
import { CliError, ConfigError, NotFoundError, UsageError } from "./errors.js";
import type { Resource } from "./models.js";

export interface DownloadRequest {
  source: string;
  destination?: string;
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

interface ResolvedDownload {
  response: Response;
  sourceUrl: string;
  requestUrl: string;
  targetName?: string;
}

const ACCEPTED_SOURCE_HINT = "Use a positive resource activity ID, a same-site resource URL, or a same-site pluginfile URL.";
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

export async function downloadMoodleFile(
  client: MoodleClient,
  request: DownloadRequest,
  signal?: AbortSignal,
): Promise<DownloadReceipt> {
  throwIfCancelled(signal);
  const explicitDestination = request.destination ? path.resolve(request.destination) : undefined;
  if (explicitDestination && !request.force) {
    await ensureDestinationAvailable(explicitDestination);
  }

  const resolved = await resolveDownload(client, request.source, signal);
  throwIfCancelled(signal);
  const filename = explicitDestination
    ? path.basename(explicitDestination)
    : chooseUpstreamFilename(resolved);
  const destination = explicitDestination ?? path.resolve(filename);
  if (!explicitDestination && !request.force) {
    await ensureDestinationAvailable(destination);
  }

  const bytesWritten = await writeResponse(resolved.response, destination, Boolean(request.force), signal);
  return {
    file_path: destination,
    filename,
    bytes_written: bytesWritten,
    content_type: contentType(resolved.response),
    source_url: publicUrl(resolved.sourceUrl),
    final_url: publicUrl(resolved.response.url || resolved.requestUrl),
  };
}

async function resolveDownload(client: MoodleClient, rawSource: string, signal?: AbortSignal): Promise<ResolvedDownload> {
  const source = rawSource.trim();
  if (/^\d+$/u.test(source)) {
    const activityId = Number(source);
    if (!Number.isSafeInteger(activityId) || activityId < 1) {
      throw new UsageError("A resource activity ID must be a positive integer.", ACCEPTED_SOURCE_HINT);
    }
    const activity = await client.getActivity(activityId);
    if (activity.type !== "resource") {
      throw new UsageError(`Activity ${activityId} is '${activity.type}', not a downloadable resource.`, ACCEPTED_SOURCE_HINT);
    }
    const resource = activity as Resource & { type: string };
    const sourceUrl = resource.url || `${client.baseUrl.replace(/\/$/u, "")}/mod/resource/view.php?id=${activityId}`;
    if (resource.file_entries.length > 1) {
      throw new UsageError(`Activity ${activityId} resolved to more than one downloadable file.`, "Inspect file_entries and download one file URL at a time.");
    }
    const [fileEntry] = resource.file_entries;
    const targetUrl = fileEntry?.url || resource.target_url;
    const targetName = fileEntry?.name || resource.target_name;
    if (targetUrl) {
      return responseOrWrapper(client, targetUrl, sourceUrl, targetName, signal);
    }
    return responseOrWrapper(client, sourceUrl, sourceUrl, targetName, signal);
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
  const sitePath = siteUrl.pathname.replace(/\/$/u, "");
  if (url.pathname === `${sitePath}/mod/resource/view.php`) {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new UsageError("A Moodle resource URL must include a positive ?id= value.", ACCEPTED_SOURCE_HINT);
    }
    const sourceUrl = new URL(`${sitePath}/mod/resource/view.php?id=${id}`, siteUrl.origin).toString();
    return responseOrWrapper(client, url.toString(), sourceUrl, undefined, signal);
  }
  if (url.pathname.startsWith(`${sitePath}/pluginfile.php/`)) {
    return responseOrWrapper(client, url.toString(), url.toString(), undefined, signal);
  }
  throw new UsageError(`Unsupported download source '${publicUrl(url.toString())}'.`, ACCEPTED_SOURCE_HINT);
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
