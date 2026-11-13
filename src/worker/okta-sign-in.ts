import { OktaSignInError, type Cookie } from "okta-auth-cli";

import { siteRootPath } from "../site-root.js";

// The Worker signing in to Moodle through Okta by itself, with okta-auth's plain
// HTTP sign-in and the OKTA_* Worker secrets. This file holds the rules; the
// session broker holds the storage and calls okta-auth.

export interface OktaSecretsEnv {
  OKTA_USERNAME?: string;
  OKTA_PASSWORD?: string;
  OKTA_TOTP_SECRET?: string;
}

export interface OktaSecrets {
  username: string;
  password: string;
  totpSecret: string;
}

// Kept encrypted next to the Moodle session.
export interface OktaState {
  // Digest of the secrets the fields below were earned with. Different secrets
  // start over, which is how changing any of them lifts a block.
  secrets: string;
  // A refusal no retry can fix (wrong password, unsupported MFA, another
  // account), or too many transient failures in a row. Nothing runs while set.
  blocked?: OktaBlockCode;
  failures: number;
  next_attempt_at?: number;
  // Okta's DT cookie: without it, every sign-in is a "new device" to Okta.
  device_token?: string;
  // While these last, Okta skips the password and the one-time code.
  okta_session?: Cookie[];
}

export type OktaBlockCode =
  | "credentials_rejected"
  | "passcode_rejected"
  | "mfa_unsupported"
  | "invalid_secret"
  | "account_mismatch"
  | "retries_exhausted";

// Okta checks a one-time code once; two attempts inside one 30-second window
// would send the same code twice and read as a rejected passcode.
export const MIN_ATTEMPT_INTERVAL_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
export const MAX_TRANSIENT_FAILURES = 5;

/** All three secrets, or null: the Worker only signs in by itself when every one is set. */
export function oktaSecrets(env: OktaSecretsEnv): OktaSecrets | null {
  const username = env.OKTA_USERNAME?.trim();
  const password = env.OKTA_PASSWORD;
  const totpSecret = env.OKTA_TOTP_SECRET?.trim();
  return username && password && totpSecret ? { username, password, totpSecret } : null;
}

// Only ever stored inside the encrypted record, so a plain SHA-256 is enough to
// tell whether the secrets changed.
export async function secretsDigest(secrets: OktaSecrets): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([secrets.username, secrets.password, secrets.totpSecret]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The stored state when it belongs to these secrets; a clean slate otherwise. */
export function stateFor(stored: OktaState | undefined, digest: string): OktaState {
  if (stored?.secrets === digest) return stored;
  // A new username must not ride on the old account's Okta session. The device
  // token names this Worker, not the account, so it stays.
  return { secrets: digest, failures: 0, ...(stored?.device_token ? { device_token: stored.device_token } : {}) };
}

export function readyToAttempt(state: OktaState, now: number): boolean {
  return !state.blocked && (state.next_attempt_at === undefined || state.next_attempt_at <= now);
}

/** When the next attempt may run, or null when none will until something changes. */
export function nextAttemptAt(state: OktaState): number | null {
  return state.blocked ? null : state.next_attempt_at ?? null;
}

export function afterSuccess(state: OktaState, now: number): OktaState {
  const { blocked: _, ...rest } = state;
  return { ...rest, failures: 0, next_attempt_at: now + MIN_ATTEMPT_INTERVAL_MS };
}

/**
 * Credentials, MFA and account refusals block at once: retrying cannot fix them,
 * and a rejected password counts towards Okta's lockout. Anything else backs off
 * and blocks after MAX_TRANSIENT_FAILURES in a row.
 */
export function afterFailure(state: OktaState, error: unknown, now: number): OktaState {
  const permanent = permanentCode(error);
  if (permanent) return { ...state, blocked: permanent, next_attempt_at: undefined };
  const failures = state.failures + 1;
  if (failures >= MAX_TRANSIENT_FAILURES) return { ...state, failures, blocked: "retries_exhausted", next_attempt_at: undefined };
  const delay = Math.min(MIN_ATTEMPT_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
  return { ...state, failures, next_attempt_at: now + delay };
}

/** A session that arrived some other way restarts transient retries, never a credentials block. */
export function afterOtherSignIn(state: OktaState): OktaState {
  if (state.blocked !== "retries_exhausted" && state.failures === 0) return state;
  const { blocked, ...rest } = state;
  return { ...rest, failures: 0, ...(blocked && blocked !== "retries_exhausted" ? { blocked } : {}) };
}

export class OktaAccountMismatch extends Error {
  constructor() {
    super("Okta signed in to a different Moodle account than the one this Worker holds.");
    this.name = "OktaAccountMismatch";
  }
}

function permanentCode(error: unknown): OktaBlockCode | null {
  if (error instanceof OktaAccountMismatch) return "account_mismatch";
  if (error instanceof OktaSignInError) {
    if (error.code === "credentials_rejected" || error.code === "passcode_rejected" || error.code === "mfa_unsupported") {
      return error.code;
    }
    return null;
  }
  // okta-auth throws TypeError for input it refuses before reaching Okta, such
  // as a TOTP secret that is not base32.
  return error instanceof TypeError ? "invalid_secret" : null;
}

/** The MoodleSession cookie Okta's sign-in left for this site, deepest matching path first. */
export function moodleCookie(cookies: readonly Cookie[], siteRoot: string): { name: string; value: string } | null {
  const sitePath = `${siteRootPath(siteRoot)}/`;
  const match = cookies
    .filter((cookie) => /^MoodleSession[A-Za-z0-9_-]*$/.test(cookie.name) && cookie.value)
    .filter((cookie) => sitePath.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  return match ? { name: match.name, value: match.value } : null;
}
