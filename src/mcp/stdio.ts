import {
  isSupportedProtocolVersion,
  jsonRpcFailure,
  type McpProtocolVersion,
} from "./protocol.js";
import type { MoodleMcpServer } from "./server.js";

export interface McpStdioInput extends AsyncIterable<string | Uint8Array> {}

export interface McpStdioOutput {
  write(chunk: string): unknown;
}

export interface MoodleMcpStdioOptions {
  input: McpStdioInput;
  output: McpStdioOutput;
  protocolVersion?: McpProtocolVersion;
}

export async function serveMoodleMcpStdio(
  server: MoodleMcpServer,
  options: MoodleMcpStdioOptions,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let protocolVersion = options.protocolVersion;

  const processLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) {
      return;
    }

    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      await writeResponse(options.output, jsonRpcFailure(null, {
        code: -32700,
        message: "Parse error.",
        data: { type: "INVALID_JSON" },
      }));
      return;
    }

    const response = await server.handle(
      request,
      protocolVersion ? { protocolVersion } : undefined,
    );
    if (response) {
      await writeResponse(options.output, response);
    }

    const requestedVersion = initializeProtocolVersion(request);
    if (requestedVersion && isSupportedProtocolVersion(requestedVersion) && response && "result" in response) {
      protocolVersion = requestedVersion;
    }
  };

  for await (const chunk of options.input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await processLine(line);
      newline = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    await processLine(buffer);
  }
}

async function writeResponse(output: McpStdioOutput, response: unknown): Promise<void> {
  await output.write(`${JSON.stringify(response)}\n`);
}

function initializeProtocolVersion(input: unknown): string | undefined {
  if (!isRecord(input) || input.method !== "initialize" || !isRecord(input.params)) {
    return undefined;
  }
  return typeof input.params.protocolVersion === "string" ? input.params.protocolVersion : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
