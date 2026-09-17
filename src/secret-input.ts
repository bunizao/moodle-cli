/**
 * Reading a session cookie from a prompt keeps it out of argv and the shell
 * history, which is where a `MOODLE_SESSION=... moodle ...` invocation leaves it.
 */
export async function readSecretLine(
  input: NodeJS.ReadStream,
  output: NodeJS.WritableStream,
  prompt: string,
): Promise<string | null> {
  if (!input.isTTY) {
    return (await readAll(input)).trim();
  }

  // Raw mode first: a paste that lands before it is set would be echoed.
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  output.write(prompt);
  try {
    return await new Promise<string | null>((resolve) => {
      let line = "";
      const finish = (value: string | null) => {
        input.off("data", onData);
        resolve(value);
      };
      const onData = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3 || byte === 4) return finish(null);
          if (byte === 13 || byte === 10) return finish(line.trim());
          if (byte === 8 || byte === 127) line = line.slice(0, -1);
          else if (byte >= 32) line += String.fromCharCode(byte);
        }
      };
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    output.write("\n");
  }
}

async function readAll(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
}
