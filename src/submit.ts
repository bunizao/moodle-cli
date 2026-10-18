import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { UsageError } from "./errors.js";
import type { SubmitFile } from "./moodle-assign-core.js";

export interface SubmitLocalFilesRequest {
  activityId: number;
  /** Local paths; `~/` expands to the home directory. */
  files: string[];
  text?: string;
  textFile?: string;
  cwd?: string;
  final?: boolean;
  replace?: boolean;
  acceptStatement?: boolean;
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}

export function resolveSubmissionPath(given: string, cwd = process.cwd()): string {
  return path.resolve(cwd, given.startsWith("~/") ? path.join(homedir(), given.slice(2)) : given);
}

export async function readSubmissionFiles(paths: string[], cwd = process.cwd()): Promise<SubmitFile[]> {
  const files: SubmitFile[] = [];
  for (const given of paths) {
    const resolved = resolveSubmissionPath(given, cwd);
    const info = await stat(resolved).catch(() => null);
    if (!info) throw new UsageError(`File not found: ${given}`);
    if (!info.isFile()) throw new UsageError(`Not a file: ${given}`, "Zip a folder before uploading it.");
    files.push({ name: path.basename(resolved), bytes: await readFile(resolved), path: resolved });
  }
  return files;
}

/** Inline and Markdown inputs are plain text; only .html/.htm files supply HTML. */
export async function readSubmissionText(request: Pick<SubmitLocalFilesRequest, "text" | "textFile" | "cwd">): Promise<string | undefined> {
  if (request.text !== undefined && request.textFile !== undefined) throw new UsageError("Use either --text or --text-file, not both.");
  let text = request.text;
  if (request.textFile !== undefined) {
    const [file] = await readSubmissionFiles([request.textFile], request.cwd);
    text = new TextDecoder().decode(file.bytes);
    if (/\.html?$/iu.test(file.name)) {
      if (!text.trim()) throw new UsageError("Online text must not be empty.");
      return text;
    }
  }
  if (text === undefined) return undefined;
  if (!text.trim()) throw new UsageError("Online text must not be empty.");
  const escaped = text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return escaped.replace(/\r\n?/gu, "\n").split(/\n[ \t]*\n/gu).map(paragraph => `<p>${paragraph.replace(/\n/gu, "<br>")}</p>`).join("\n");
}
