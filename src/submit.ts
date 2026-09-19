import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { UsageError } from "./errors.js";
import type { SubmitFile } from "./moodle-assign-core.js";

export interface SubmitLocalFilesRequest {
  activityId: number;
  /** Local paths; `~/` expands to the home directory. */
  files: string[];
  cwd?: string;
  final?: boolean;
  replace?: boolean;
  acceptStatement?: boolean;
  dryRun?: boolean;
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
