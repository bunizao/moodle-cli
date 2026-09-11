import { createHash, randomBytes } from "node:crypto";
import { createDefaultCredentialStore } from "./mcp/credentials/node-store.js";
import { createEncryptionKeyring, decryptValue, encryptValue } from "./worker/crypto.js";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CACHE_DIR_NAME,
  DEFAULT_SESSION_CACHE_TTL_MS,
  SESSION_CACHE_FILENAME,
} from "./constants.js";

export interface CachedSession {
  baseUrl: string;
  cookieName: string;
  cookieValue: string;
  sesskey: string;
  userid: number;
  savedAt: number;
}

export interface SessionCacheOptions {
  homeDir?: string;
  ttlMs?: number;
  now?: () => number;
  noCache?: boolean;
  fs?: SessionCacheFs;
  encryptionKey?: () => Promise<string>;
}

export interface SessionCacheFs {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
  rm: typeof rm;
  chmod: typeof chmod;
}

const nodeFs: SessionCacheFs = { readFile, writeFile, mkdir, rm, chmod };

export function sessionCachePath(homeDir = homedir()): string {
  return join(homeDir, CACHE_DIR_NAME, SESSION_CACHE_FILENAME);
}

export function isCachedSessionFresh(
  session: CachedSession,
  ttlMs = DEFAULT_SESSION_CACHE_TTL_MS,
  now = Date.now,
): boolean {
  const age = now() - session.savedAt;
  return age >= 0 && age <= ttlMs;
}

export async function readCachedSession(
  baseUrl: string,
  options: SessionCacheOptions = {},
): Promise<CachedSession | null> {
  if (options.noCache) {
    return null;
  }

  const fs = options.fs ?? nodeFs;
  const path = sessionCachePath(options.homeDir);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  let session: CachedSession | null;
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && value.version === 2 && typeof value.encrypted_session === "string") {
      const keyring = await createEncryptionKeyring(await cacheEncryptionKey(options));
      session = parseCachedSession((await decryptValue(value.encrypted_session, keyring)).value);
    } else {
      session = parseCachedSession(raw);
      if (session) await writeCachedSession(session, { ...options, noCache: false });
    }
  } catch {
    return null;
  }
  if (!session || !sameBaseUrl(session.baseUrl, baseUrl)) {
    return null;
  }

  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_CACHE_TTL_MS;
  return isCachedSessionFresh(session, ttlMs, options.now ?? Date.now) ? session : null;
}

export async function writeCachedSession(
  session: CachedSession,
  options: SessionCacheOptions = {},
): Promise<void> {
  if (options.noCache) return;
  const fs = options.fs ?? nodeFs;
  const path = sessionCachePath(options.homeDir);
  const keyring = await createEncryptionKeyring(await cacheEncryptionKey(options));
  const encrypted = { version: 2, encrypted_session: await encryptValue(JSON.stringify(session), keyring) };
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, `${JSON.stringify(encrypted)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(path, 0o600);
}

export async function deleteCachedSession(
  baseUrl: string,
  options: SessionCacheOptions = {},
): Promise<void> {
  const current = await readCachedSession(baseUrl, { ...options, noCache: false, ttlMs: Number.MAX_SAFE_INTEGER });
  if (!current) {
    return;
  }

  const fs = options.fs ?? nodeFs;
  try {
    await fs.rm(sessionCachePath(options.homeDir), { force: true });
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function parseCachedSession(raw: string): CachedSession | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const session = value as Partial<CachedSession>;
  if (
    typeof session.baseUrl !== "string" ||
    typeof session.cookieName !== "string" ||
    typeof session.cookieValue !== "string" ||
    typeof session.sesskey !== "string" ||
    typeof session.userid !== "number" ||
    typeof session.savedAt !== "number"
  ) {
    return null;
  }

  return {
    baseUrl: session.baseUrl,
    cookieName: session.cookieName,
    cookieValue: session.cookieValue,
    sesskey: session.sesskey,
    userid: session.userid,
    savedAt: session.savedAt,
  };
}

function sameBaseUrl(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return left === right;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

const pendingCacheKeys = new Map<string, Promise<string>>();

async function cacheEncryptionKey(options: SessionCacheOptions): Promise<string> {
  if (options.encryptionKey) return options.encryptionKey();
  const homeDirectory = options.homeDir ?? homedir();
  let pending = pendingCacheKeys.get(homeDirectory);
  if (!pending) {
    pending = (async () => {
      const store = createDefaultCredentialStore({ homeDirectory });
      const profile = `local-cache-${createHash("sha256").update(homeDirectory).digest("hex").slice(0, 16)}`;
      const existing = await store.read(profile);
      if (existing) return existing.sessionEncryptionKey;
      const sessionEncryptionKey = randomBytes(32).toString("base64url");
      // The cache uses only the shared vault record's encryption key, never transport credentials.
      await store.write(profile, { mcpAccessToken: "", sessionSyncToken: "", sessionEncryptionKey });
      return sessionEncryptionKey;
    })();
    pendingCacheKeys.set(homeDirectory, pending);
    pending.catch(() => pendingCacheKeys.delete(homeDirectory));
  }
  return pending;
}
