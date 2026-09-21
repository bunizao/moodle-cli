// Runtime-neutral pieces of the update check; the CLI and the Worker both ask npm
// for the published version and compare it with the one they were built from.

import { GITHUB_RELEASES_URL } from "./constants.js";

export const PACKAGE_NAME = "moodle-cli";
// The dist-tags document is a few bytes; the full packument is hundreds of kilobytes.
export const LATEST_VERSION_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export interface LatestVersionRecord {
  latest: string;
  checked_at: number;
}

/** Positive when `a` is newer than `b`. A prerelease ranks below its release. */
export function compareVersions(a: string, b: string): number {
  const [aMain, aPre] = a.split("-", 2);
  const [bMain, bPre] = b.split("-", 2);
  const left = aMain.split(".").map(Number);
  const right = bMain.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (Boolean(aPre) === Boolean(bPre)) return (aPre ?? "").localeCompare(bPre ?? "");
  return aPre ? -1 : 1;
}

export function isNewerVersion(candidate: string | undefined, current: string): boolean {
  return Boolean(candidate) && /^\d+\.\d+\.\d+/u.test(candidate!) && compareVersions(candidate!, current) > 0;
}

export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<string | null> {
  try {
    const response = await fetchImpl(LATEST_VERSION_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const tags = await response.json() as { latest?: unknown };
    return typeof tags.latest === "string" ? tags.latest : null;
  } catch {
    return null;
  }
}

export function updateHint(current: string, latest: string): string {
  return `moodle-cli ${latest} is available (running ${current}). Run: moodle update`;
}

export function standaloneUpdateHint(current: string, latest: string): string {
  return `moodle-cli ${latest} is available (running ${current}). Download it from ${GITHUB_RELEASES_URL}`;
}
