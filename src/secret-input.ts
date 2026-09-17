/**
 * Reading a session cookie from a prompt keeps it out of argv and the shell
 * history, which is where a `MOODLE_SESSION=... moodle ...` invocation leaves it.
 */

// Terminal bracketed-paste markers. With paste mode enabled the terminal wraps a
// paste in these, so a multi-line blob (a "Copy as cURL" command) arrives as one
// unit and its embedded newlines are content, not an early end-of-input.
const PASTE_MODE_ON = "\x1b[?2004h";
const PASTE_MODE_OFF = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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
  // Ask the terminal to bracket pastes so multi-line input survives.
  output.write(PASTE_MODE_ON);
  try {
    return await new Promise<string | null>((resolve) => {
      let content = "";
      let pasting = false;
      // Accumulates the bytes of a possible escape marker, which may be split
      // across chunks.
      let esc = "";
      const finish = (value: string | null) => {
        input.off("data", onData);
        resolve(value);
      };
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (esc) {
            esc += ch;
            if (esc === PASTE_START) {
              pasting = true;
              esc = "";
            } else if (esc === PASTE_END) {
              // A completed paste is the whole value; submit it.
              esc = "";
              return finish(content.trim());
            } else if (!PASTE_START.startsWith(esc) && !PASTE_END.startsWith(esc)) {
              // Some other escape sequence (arrow keys, etc.); drop it.
              esc = "";
            }
            continue;
          }
          const code = ch.charCodeAt(0);
          if (code === 27) {
            esc = "\x1b";
            continue;
          }
          if (pasting) {
            // Everything inside a paste is literal, newlines included.
            content += ch;
            continue;
          }
          if (code === 3 || code === 4) return finish(null); // Ctrl-C / Ctrl-D
          if (code === 13 || code === 10) return finish(content.trim());
          if (code === 8 || code === 127) content = content.slice(0, -1);
          else if (code >= 32) content += ch;
        }
      };
      input.on("data", onData);
    });
  } finally {
    output.write(PASTE_MODE_OFF);
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
