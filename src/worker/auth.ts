export async function digestBearerToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyBearerToken(authorization: string | null, allowedDigests: Array<string | undefined>): Promise<boolean> {
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  if (!token || token.trim() !== token) return false;
  const candidate = await digestBearerToken(token);
  let matches = 0;
  for (const allowed of allowedDigests) {
    if (!allowed || allowed.length !== candidate.length) continue;
    let difference = 0;
    for (let index = 0; index < candidate.length; index += 1) {
      difference |= candidate.charCodeAt(index) ^ allowed.charCodeAt(index);
    }
    matches |= Number(difference === 0);
  }
  return matches !== 0;
}

const QUERY_CREDENTIAL_NAMES = new Set(["access_token", "api_key", "apikey", "authorization", "bearer", "token"]);

export function hasQueryCredential(url: URL): boolean {
  return Array.from(url.searchParams.keys()).some((name) => QUERY_CREDENTIAL_NAMES.has(name.toLowerCase()));
}
