import { jsonRpcFailure, MODERN_PROTOCOL_VERSION, type JsonRpcId } from "./protocol.js";

export interface RemoteMcpBridgeInput extends AsyncIterable<string | Uint8Array> {}

export interface RemoteMcpBridgeOutput {
  write(chunk: string): unknown;
}

export interface RemoteMcpBridgeOptions {
  endpoint: string;
  accessToken: string;
  input: RemoteMcpBridgeInput;
  output: RemoteMcpBridgeOutput;
  fetchImpl?: typeof fetch;
}

interface BridgeRequest {
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export async function bridgeRemoteMcp(options: RemoteMcpBridgeOptions): Promise<void> {
  if (!options.accessToken) {
    throw new Error("The managed MCP access credential is missing.");
  }
  const endpoint = normalizeMcpEndpoint(options.endpoint);
  const fetchImpl = options.fetchImpl ?? fetch;
  const decoder = new TextDecoder();
  let buffer = "";
  let negotiatedProtocolVersion: string = MODERN_PROTOCOL_VERSION;

  const processLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;

    let request: BridgeRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isBridgeRequest(parsed)) throw new Error("invalid request");
      request = parsed;
    } catch {
      await writeJson(options.output, jsonRpcFailure(null, {
        code: -32700,
        message: "Parse error.",
        data: { type: "INVALID_JSON" },
      }));
      return;
    }

    const headers = new Headers({
      authorization: `Bearer ${options.accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion(request, negotiatedProtocolVersion),
      "mcp-method": request.method,
    });
    if (request.method === "tools/call" && typeof request.params?.name === "string") {
      headers.set("mcp-name", request.params.name);
    }
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: line,
      });
    } catch {
      await writeRemoteError(options.output, request.id, 0);
      return;
    }

    if (response.status === 202 || request.id === undefined) return;
    if (!response.ok) {
      await writeRemoteError(options.output, request.id, response.status);
      return;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) {
      const forwarded = await writeSseMessages(options.output, await response.text(), request.id);
      if (forwarded) negotiatedProtocolVersion = initializedProtocolVersion(request) ?? negotiatedProtocolVersion;
      return;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      await writeRemoteError(options.output, request.id, response.status);
      return;
    }
    if (request.method === "initialize" && isRecord(payload) && "result" in payload) {
      negotiatedProtocolVersion = responseProtocolVersion(payload)
        ?? initializedProtocolVersion(request)
        ?? negotiatedProtocolVersion;
    }
    await writeJson(options.output, payload);
  };

  for await (const chunk of options.input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      await processLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await processLine(buffer);
}

function normalizeMcpEndpoint(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname === "/" ? "/mcp" : url.pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function protocolVersion(request: BridgeRequest, negotiatedVersion: string): string {
  const meta = isRecord(request.params?._meta) ? request.params?._meta : undefined;
  const metadataVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  if (typeof metadataVersion === "string") return metadataVersion;
  return initializedProtocolVersion(request) ?? negotiatedVersion;
}

function initializedProtocolVersion(request: BridgeRequest): string | undefined {
  const initialized = request.method === "initialize" ? request.params?.protocolVersion : undefined;
  return typeof initialized === "string" ? initialized : undefined;
}

function responseProtocolVersion(payload: Record<string, unknown>): string | undefined {
  const result = isRecord(payload.result) ? payload.result : undefined;
  return typeof result?.protocolVersion === "string" ? result.protocolVersion : undefined;
}

async function writeSseMessages(output: RemoteMcpBridgeOutput, body: string, id: JsonRpcId | undefined): Promise<boolean> {
  let wrote = false;
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trimStart();
    if (!data || data === "[DONE]") continue;
    try {
      await writeJson(output, JSON.parse(data));
      wrote = true;
    } catch {
      await writeRemoteError(output, id, 200);
      return false;
    }
  }
  if (!wrote) await writeRemoteError(output, id, 200);
  return wrote;
}

async function writeRemoteError(output: RemoteMcpBridgeOutput, id: JsonRpcId | undefined, status: number): Promise<void> {
  if (id === undefined) return;
  await writeJson(output, jsonRpcFailure(id, {
    code: -32000,
    message: "The remote Moodle MCP server could not complete the request.",
    data: { type: "REMOTE_MCP_ERROR", status },
  }));
}

async function writeJson(output: RemoteMcpBridgeOutput, value: unknown): Promise<void> {
  await output.write(`${JSON.stringify(value)}\n`);
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
  return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
