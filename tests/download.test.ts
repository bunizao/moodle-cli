import { readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MoodleClient } from "../src/client.js";
import { runCli } from "../src/cli.js";
import { ENV_MOODLE_BASE_URL, ENV_MOODLE_SESSION } from "../src/constants.js";
import { downloadMoodleFile } from "../src/download.js";

const BASE_URL = "https://school.example.edu";

describe("Moodle file downloads", () => {
  it("streams a direct Moodle file to an explicit destination and returns a receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "week-03.pdf");
    const source = `${BASE_URL}/pluginfile.php/1/mod_resource/content/1/slides.pdf`;
    const requestAbsolute = vi.fn(async () => responseAt(source, "slides", {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="upstream.pdf"',
    }));

    const receipt = await downloadMoodleFile(client({ requestAbsolute }), {
      source,
      destination,
    });

    expect(receipt).toEqual({
      file_path: destination,
      filename: "week-03.pdf",
      bytes_written: 6,
      content_type: "application/pdf",
      source_url: source,
      final_url: source,
    });
    await expect(readFile(destination, "utf8")).resolves.toBe("slides");
    await expect(readdir(directory)).resolves.toEqual(["week-03.pdf"]);
  });

  it("resolves a numeric resource activity and preserves its wrapper as the source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    const wrapper = `${BASE_URL}/mod/resource/view.php?id=91234`;
    const file = `${BASE_URL}/pluginfile.php/1/mod_resource/content/1/slides.pdf`;
    const getActivity = vi.fn(async () => ({
      id: 91234,
      name: "Lecture Slides",
      course_id: 101,
      course_name: "Example Course",
      section_name: "Week 3",
      type: "resource",
      target_name: "slides.pdf",
      target_url: file,
      file_entries: [{ name: "slides.pdf", url: file, requires_authentication: true }],
      url: wrapper,
    }));
    const requestAbsolute = vi.fn(async () => responseAt(file, "pdf", { "content-type": "application/pdf" }));

    const receipt = await downloadMoodleFile(client({ getActivity, requestAbsolute }), {
      source: "91234",
      destination,
    });

    expect(getActivity).toHaveBeenCalledWith(91234);
    expect(requestAbsolute).toHaveBeenCalledWith(file, { signal: undefined });
    expect(receipt).toMatchObject({ source_url: wrapper, final_url: file });
  });

  it("follows a relative file link from a resource wrapper", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    const wrapper = `${BASE_URL}/mod/resource/view.php?id=21`;
    const file = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    const requestAbsolute = vi.fn(async (url: string) => url === wrapper
      ? responseAt(wrapper, '<div class="resourcecontent"><a href="/pluginfile.php/1/slides.pdf">slides.pdf</a></div>', {
          "content-type": "text/html",
        })
      : responseAt(file, "slides", { "content-type": "application/pdf" }));

    const receipt = await downloadMoodleFile(client({ requestAbsolute }), {
      source: wrapper,
      destination,
    });

    expect(requestAbsolute).toHaveBeenCalledTimes(2);
    expect(receipt).toMatchObject({ source_url: wrapper, final_url: file, bytes_written: 6 });
  });

  it("accepts an automatic resource redirect to a non-HTML response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    const wrapper = `${BASE_URL}/mod/resource/view.php?id=21`;
    const file = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    const requestAbsolute = vi.fn(async () => responseAt(file, "slides", { "content-type": "application/pdf" }));

    const receipt = await downloadMoodleFile(client({ requestAbsolute }), {
      source: wrapper,
      destination,
    });

    expect(receipt.final_url).toBe(file);
    expect(requestAbsolute).toHaveBeenCalledOnce();
  });

  it.each([
    ["attachment; filename*=UTF-8''lecture%20slides.pdf", "lecture slides.pdf"],
    ['attachment; filename="quoted slides.pdf"', "quoted slides.pdf"],
    [undefined, "fallback.pdf"],
  ])("selects a safe upstream filename from %s", async (disposition, expected) => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    const source = `${BASE_URL}/pluginfile.php/1/${expected === "fallback.pdf" ? "fallback.pdf" : "ignored"}`;
    const headers: Record<string, string> = { "content-type": "application/pdf" };
    if (disposition) headers["content-disposition"] = disposition;
    try {
      const receipt = await downloadMoodleFile(client({
        requestAbsolute: async () => responseAt(source, "pdf", headers),
      }), { source });

      expect(receipt.filename).toBe(expected);
      await expect(readFile(join(directory, expected), "utf8")).resolves.toBe("pdf");
    } finally {
      cwd.mockRestore();
    }
  });

  it("rejects an existing explicit destination before requesting Moodle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    await writeFile(destination, "keep", "utf8");
    const requestAbsolute = vi.fn();

    await expect(downloadMoodleFile(client({ requestAbsolute }), {
      source: `${BASE_URL}/pluginfile.php/1/slides.pdf`,
      destination,
    })).rejects.toMatchObject({ code: "usage", message: expect.stringContaining(destination) });
    expect(requestAbsolute).not.toHaveBeenCalled();
    await expect(readFile(destination, "utf8")).resolves.toBe("keep");
  });

  it("atomically replaces an existing destination only with force", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    await writeFile(destination, "old", "utf8");

    await downloadMoodleFile(client({
      requestAbsolute: async () => responseAt(source, "replacement", { "content-type": "application/pdf" }),
    }), { source, destination, force: true });

    await expect(readFile(destination, "utf8")).resolves.toBe("replacement");
    await expect(readdir(directory)).resolves.toEqual(["slides.pdf"]);
  });

  it("rejects unsupported sources and activity types with usage guidance", async () => {
    await expect(downloadMoodleFile(client({}), { source: "not-a-source" })).rejects.toMatchObject({ code: "usage" });
    await expect(downloadMoodleFile(client({
      getActivity: async () => ({ id: 9, type: "folder" }) as never,
    }), { source: "9" })).rejects.toMatchObject({
      code: "usage",
      hint: expect.stringContaining("resource activity ID"),
    });
    await expect(downloadMoodleFile(client({}), {
      source: "https://other.example.edu/pluginfile.php/1/slides.pdf",
    })).rejects.toMatchObject({ code: "usage" });
  });

  it("maps a 200 login page to auth without creating the destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;

    await expect(downloadMoodleFile(client({
      requestAbsolute: async () => responseAt(source, '<form action="/login/index.php"><input name="password"></form>', {
        "content-type": "text/html",
      }),
    }), { source, destination })).rejects.toMatchObject({ code: "auth" });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("removes temporary output after cancellation during streaming", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("partial"));
      },
    });
    const pending = downloadMoodleFile(client({
      requestAbsolute: async () => responseAt(source, body, { "content-type": "application/pdf" }),
    }), { source, destination }, controller.signal);
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("does not request Moodle when cancellation is already signalled", async () => {
    const requestAbsolute = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(downloadMoodleFile(client({ requestAbsolute }), {
      source: `${BASE_URL}/pluginfile.php/1/slides.pdf`,
    }, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(requestAbsolute).not.toHaveBeenCalled();
  });

  it("removes temporary output after the response stream fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("partial"));
        stream.error(new Error("socket reset with secret-cookie"));
      },
    });
    const pending = downloadMoodleFile(client({
      requestAbsolute: async () => responseAt(source, body, { "content-type": "application/pdf" }),
    }), { source, destination });

    await expect(pending).rejects.toMatchObject({ code: "network" });
    await expect(pending.catch((error: Error) => error.message)).resolves.not.toContain("secret-cookie");
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("rejects a server-derived destination conflict without replacing the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    const destination = join(directory, "slides.pdf");
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    await writeFile(destination, "keep", "utf8");
    try {
      await expect(downloadMoodleFile(client({
        requestAbsolute: async () => responseAt(source, "new", { "content-type": "application/pdf" }),
      }), { source })).rejects.toMatchObject({ code: "usage" });
      await expect(readFile(destination, "utf8")).resolves.toBe("keep");
    } finally {
      cwd.mockRestore();
    }
  });

  it("rejects a resource wrapper with no file target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    const wrapper = `${BASE_URL}/mod/resource/view.php?id=21`;

    await expect(downloadMoodleFile(client({
      requestAbsolute: async () => responseAt(wrapper, "<main>No file here</main>", { "content-type": "text/html" }),
    }), { source: wrapper, destination })).rejects.toMatchObject({ code: "not_found" });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("reports a missing parent as config without exposing temporary paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "missing", "slides.pdf");
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;

    const result = downloadMoodleFile(client({
      requestAbsolute: async () => responseAt(source, "slides", { "content-type": "application/pdf" }),
    }), { source, destination });

    await expect(result).rejects.toMatchObject({ code: "config", message: expect.stringContaining(destination) });
    await expect(result.catch((error: Error) => error.message)).resolves.not.toContain(".moodle-");
  });

  it("redacts session material from receipt URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const destination = join(directory, "slides.pdf");
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf?sesskey=secret&forcedownload=1`;
    const receipt = await downloadMoodleFile(client({
      requestAbsolute: async () => responseAt(source, "slides", { "content-type": "application/pdf" }),
    }), { source, destination });

    expect(JSON.stringify(receipt)).not.toContain("secret");
    expect(receipt.source_url).toBe(`${BASE_URL}/pluginfile.php/1/slides.pdf?forcedownload=1`);
  });

  it.each(["download", "dl"])("exposes %s with one JSON receipt on non-TTY stdout", async (command) => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-cli-"));
    const destination = join(directory, `${command}.pdf`);
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    const result = await runDownloadCli([command, source, "--dest", destination], source);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      file_path: destination,
      filename: `${command}.pdf`,
      bytes_written: 6,
    });
    await expect(readFile(destination, "utf8")).resolves.toBe("slides");
  });

  it("describes dl as an alias and keeps receipt output separate from --dest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-cli-"));
    const destination = join(directory, "slides.pdf");
    const receiptPath = join(directory, "receipt.json");
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    const commandTree = await runDownloadCli(["commands", "--json"], source);
    const download = JSON.parse(commandTree.stdout).commands.find((command: { name: string }) => command.name === "download");
    expect(download).toMatchObject({ aliases: ["dl"], mutating: false });

    const result = await runDownloadCli([
      "download",
      source,
      "--dest",
      destination,
      "--output",
      receiptPath,
      "--json",
    ], source);

    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    await expect(readFile(destination, "utf8")).resolves.toBe("slides");
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ file_path: destination });
  });
});

function client(overrides: Partial<MoodleClient>): MoodleClient {
  return {
    baseUrl: BASE_URL,
    requestAbsolute: async () => {
      throw new Error("Unexpected request");
    },
    ...overrides,
  } as MoodleClient;
}

function responseAt(url: string, body: BodyInit, headers: HeadersInit = {}): Response {
  const response = new Response(body, { headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

async function runDownloadCli(args: string[], source: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = buffer();
  const stderr = buffer();
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === `${BASE_URL}/my/`) {
      return responseAt(url, '<script>M.cfg = {"sesskey":"sess","userId":7};</script><body data-user-id="7"></body>', {
        "content-type": "text/html",
      });
    }
    if (url === source) {
      return responseAt(url, "slides", { "content-type": "application/pdf" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const code = await runCli(["node", "moodle", ...args], {
    stdout,
    stderr,
    fetchImpl,
    env: {
      [ENV_MOODLE_BASE_URL]: BASE_URL,
      [ENV_MOODLE_SESSION]: "secret-cookie",
    },
    homeDir: await mkdtemp(join(tmpdir(), "moodle-download-home-")),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function buffer() {
  let value = "";
  return {
    isTTY: false,
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text() {
      return value;
    },
  };
}
