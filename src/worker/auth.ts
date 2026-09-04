export async function digestBearerToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readBearerToken(authorization: string | null): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  if (!token || token.trim() !== token) return null;
  return token;
}

export async function verifySecret(secret: string, allowedDigests: Array<string | undefined>): Promise<boolean> {
  const candidateKey = await importHmacKey(await digestBearerToken(secret), ["sign"]);
  if (!candidateKey) return false;
  const challenge = new TextEncoder().encode("moodle-mcp-bearer-digest");
  const signature = await crypto.subtle.sign("HMAC", candidateKey, challenge);
  for (const allowed of allowedDigests) {
    const allowedKey = allowed ? await importHmacKey(allowed, ["verify"]) : null;
    if (allowedKey && await crypto.subtle.verify("HMAC", allowedKey, signature, challenge)) return true;
  }
  return false;
}

export async function verifyBearerToken(authorization: string | null, allowedDigests: Array<string | undefined>): Promise<boolean> {
  const token = readBearerToken(authorization);
  if (!token) return false;
  return verifySecret(token, allowedDigests);
}

const QUERY_CREDENTIAL_NAMES = new Set(["access_token", "api_key", "apikey", "authorization", "bearer", "token"]);

export function hasQueryCredential(url: URL): boolean {
  return Array.from(url.searchParams.keys()).some((name) => QUERY_CREDENTIAL_NAMES.has(name.toLowerCase()));
}

async function importHmacKey(digest: string, usages: KeyUsage[]): Promise<CryptoKey | null> {
  if (!/^[0-9a-f]{64}$/i.test(digest)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  }
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, usages);
}
