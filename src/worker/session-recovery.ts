export interface SessionRecoveryRequest {
  moodleOrigin: string;
  moodleUserId: number;
  reason: "SESSION_EXPIRED";
  signal: AbortSignal;
}

export interface RecoveredSession {
  moodleOrigin: string;
  cookieName: string;
  cookieValue: string;
}

export interface SessionRecoveryProvider {
  recover(request: SessionRecoveryRequest): Promise<RecoveredSession | null>;
}

// Structural subset of a Workers HTTP Service binding, also usable by tests.
export interface SessionRecoveryServiceBinding {
  fetch(request: Request): Promise<Response>;
}

const MAX_RESPONSE_BYTES = 16 * 1024;

export class ServiceBindingSessionRecovery implements SessionRecoveryProvider {
  constructor(private readonly service: SessionRecoveryServiceBinding) {}

  async recover(input: SessionRecoveryRequest): Promise<RecoveredSession | null> {
    const response = await this.service.fetch(new Request("https://session-recovery/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        moodleOrigin: input.moodleOrigin,
        moodleUserId: input.moodleUserId,
        reason: input.reason,
      }),
      redirect: "manual",
      signal: input.signal,
    }));
    if (response.status === 204) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      await response.body?.cancel();
      throw new Error("The session recovery service did not return a candidate.");
    }
    const value: unknown = JSON.parse(await readBoundedBody(response, input.signal));
    if (!isRecoveredSession(value)) throw new Error("The session recovery candidate is invalid.");
    return value;
  }
}

export function isRecoveredSession(value: unknown): value is RecoveredSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.moodleOrigin === "string"
    && typeof record.cookieName === "string"
    && /^MoodleSession[A-Za-z0-9_-]*$/.test(record.cookieName)
    && typeof record.cookieValue === "string"
    && record.cookieValue.length > 0
    && record.cookieValue.length <= 4096
    && !/[\u0000-\u001f\u007f;]/.test(record.cookieValue);
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error("The session recovery response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("The session recovery response is too large.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
