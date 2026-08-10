interface CiphertextEnvelope {
  version: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
}

export interface EncryptionKeyring {
  current: EncryptionKey;
  keys: Map<string, CryptoKey>;
}

interface EncryptionKey {
  id: string;
  key: CryptoKey;
}

export interface DecryptedValue {
  value: string;
  keyId: string;
  needsRotation: boolean;
}

export async function createEncryptionKeyring(currentSecret: string, previousSecret?: string): Promise<EncryptionKeyring> {
  if (!currentSecret) throw new Error("SESSION_ENCRYPTION_KEY is required.");
  const current = await deriveEncryptionKey(currentSecret);
  const keys = new Map([[current.id, current.key]]);
  if (previousSecret) {
    const previous = await deriveEncryptionKey(previousSecret);
    keys.set(previous.id, previous.key);
  }
  return { current, keys };
}

export async function encryptValue(value: string, keyring: EncryptionKeyring): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    keyring.current.key,
    new TextEncoder().encode(value),
  );
  return JSON.stringify({
    version: 1,
    keyId: keyring.current.id,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  } satisfies CiphertextEnvelope);
}

export async function decryptValue(encrypted: string, keyring: EncryptionKeyring): Promise<DecryptedValue> {
  const envelope = parseEnvelope(encrypted);
  const key = keyring.keys.get(envelope.keyId);
  if (!key) throw new Error("The session encryption key is unavailable.");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ciphertext),
  );
  return {
    value: new TextDecoder().decode(plaintext),
    keyId: envelope.keyId,
    needsRotation: envelope.keyId !== keyring.current.id,
  };
}

async function deriveEncryptionKey(secret: string): Promise<EncryptionKey> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const id = Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id, key };
}

function parseEnvelope(value: string): CiphertextEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The encrypted session record is invalid.");
  }
  if (!isRecord(parsed)
    || parsed.version !== 1
    || typeof parsed.keyId !== "string"
    || typeof parsed.iv !== "string"
    || typeof parsed.ciphertext !== "string") {
    throw new Error("The encrypted session record is invalid.");
  }
  return parsed as unknown as CiphertextEnvelope;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
