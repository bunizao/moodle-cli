import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { readSecretLine } from "../src/secret-input.js";

/** A minimal stand-in for a raw-mode TTY input stream. */
function fakeTty(): NodeJS.ReadStream {
  const stream = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = (value: boolean) => {
    stream.isRaw = value;
    return stream;
  };
  stream.resume = () => stream;
  stream.pause = () => stream;
  return stream as unknown as NodeJS.ReadStream;
}

const nullOut = { write: () => true } as unknown as NodeJS.WritableStream;

describe("readSecretLine", () => {
  it("captures a multi-line bracketed paste as one value", async () => {
    const input = fakeTty();
    const promise = readSecretLine(input, nullOut, "cookie: ");
    const curl = "curl 'https://school.example.edu/my/' \\\n  -H 'cookie: MoodleSession=abc123' \\\n  --compressed";
    input.emit("data", Buffer.from(`\x1b[200~${curl}\x1b[201~`));
    await expect(promise).resolves.toBe(curl);
  });

  it("submits a typed line on Enter", async () => {
    const input = fakeTty();
    const promise = readSecretLine(input, nullOut, "cookie: ");
    input.emit("data", Buffer.from("abc123\r"));
    await expect(promise).resolves.toBe("abc123");
  });

  it("cancels on Ctrl-C", async () => {
    const input = fakeTty();
    const promise = readSecretLine(input, nullOut, "cookie: ");
    input.emit("data", Buffer.from([3]));
    await expect(promise).resolves.toBeNull();
  });

  it("reassembles a paste split across chunks, markers included", async () => {
    const input = fakeTty();
    const promise = readSecretLine(input, nullOut, "cookie: ");
    input.emit("data", Buffer.from("\x1b[20"));
    input.emit("data", Buffer.from("0~line1\n"));
    input.emit("data", Buffer.from("line2\x1b[201~"));
    await expect(promise).resolves.toBe("line1\nline2");
  });

  it("reads and trims a non-TTY (piped) stream", async () => {
    async function* piped() {
      yield Buffer.from("MoodleSession=xyz\n");
    }
    const input = Object.assign(piped(), { isTTY: false }) as unknown as NodeJS.ReadStream;
    await expect(readSecretLine(input, nullOut, "")).resolves.toBe("MoodleSession=xyz");
  });
});
