import { readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MoodleClient } from "../src/client.js";
import { runCli } from "../src/cli.js";
import { ENV_MOODLE_BASE_URL, ENV_MOODLE_SESSION } from "../src/constants.js";
import { downloadMoodleFiles } from "../src/download.js";
import { NotFoundError } from "../src/errors.js";
import { formatDownloadResult } from "../src/formatters.js";

// Most cases here resolve to one file; the batch cases below read the whole result.
const downloadMoodleFile = async (...args: Parameters<typeof downloadMoodleFiles>) => (await downloadMoodleFiles(...args)).files[0];

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

  it("stops mid-file on abort, rejects as cancelled and leaves no partial file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-abort-"));
    const abort = new AbortController();
    // One chunk arrives, then the body stalls the way a slow file does when Ctrl+C lands.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        setTimeout(() => abort.abort(), 10);
      },
    });
    const url = `${BASE_URL}/pluginfile.php/1/big.pdf`;
    const moodle = client({ requestAbsolute: async () => responseAt(url, body, { "content-type": "application/pdf" }) });

    await expect(downloadMoodleFiles(moodle, { source: url, directory }, abort.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("reports an abort during the request as cancelled, not as a network failure", async () => {
    const abort = new AbortController();
    const moodle = client({
      requestAbsolute: async () => {
        abort.abort();
        throw new Error("Could not reach school.example.edu: This operation was aborted");
      },
    });

    await expect(downloadMoodleFiles(moodle, { source: `${BASE_URL}/pluginfile.php/1/a.pdf` }, abort.signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects unsupported sources and activity types with usage guidance", async () => {
    await expect(downloadMoodleFile(client({}), { source: "not-a-source" })).rejects.toMatchObject({ code: "usage" });
    await expect(downloadMoodleFile(client({
      getActivity: async () => ({ id: 9, type: "quiz" }) as never,
    }), { source: "9" })).rejects.toMatchObject({
      code: "usage",
      message: expect.stringContaining("'quiz'"),
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

  it("stops waiting on a slow section lookup as soon as it is cancelled", async () => {
    const controller = new AbortController();
    const hanging = client({ getActivity: () => new Promise(() => undefined) as never });
    const pending = downloadMoodleFiles(hanging, { source: `${BASE_URL}/mod/folder/view.php?id=5` }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
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
        stream.error(Object.assign(new Error("socket reset with secret-cookie"), { code: "ECONNRESET" }));
      },
    });
    const pending = downloadMoodleFile(client({
      requestAbsolute: async () => responseAt(source, body, { "content-type": "application/pdf" }),
    }), { source, destination });

    await expect(pending).rejects.toMatchObject({ code: "network" });
    await expect(pending.catch((error: Error) => error.message)).resolves.not.toContain("secret-cookie");
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("leaves a file that is already there alone and reports it, so a rerun resumes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    const destination = join(directory, "slides.pdf");
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    await writeFile(destination, "keep", "utf8");
    try {
      const result = await downloadMoodleFiles(client({
        requestAbsolute: async () => responseAt(source, "new", { "content-type": "application/pdf" }),
      }), { source });
      expect(result).toMatchObject({ files: [], total: 0, skipped: [{ name: "slides.pdf", reason: "exists", file_path: destination }] });
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

  it("saves every file of a folder into --to, suffixing a repeated name", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "moodle-download-")), "week-3");
    const file = (n: number) => `${BASE_URL}/pluginfile.php/7/mod_folder/content/0/${n}/slides.pdf`;
    const requestAbsolute = vi.fn(async (url: string) => responseAt(url, url.slice(-12), { "content-type": "application/pdf" }));
    const result = await downloadMoodleFiles(client({
      getActivity: async () => ({ id: 5, type: "folder", url: `${BASE_URL}/mod/folder/view.php?id=5`, file_entries: [
        { name: "slides.pdf", url: file(1), requires_authentication: true },
        { name: "slides.pdf", url: file(2), requires_authentication: true },
      ] }) as never,
      requestAbsolute,
    }), { source: `${BASE_URL}/mod/folder/view.php?id=5`, directory });

    expect(result.total).toBe(2);
    expect(result.files.map(f => f.filename)).toEqual(["slides.pdf", "slides (2).pdf"]);
    await expect(readdir(directory)).resolves.toEqual(["slides (2).pdf", "slides.pdf"]);
  });

  it("names each file on a dry run without creating the directory or writing anything", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "moodle-download-")), "week-3");
    const file = (n: number) => `${BASE_URL}/pluginfile.php/7/mod_folder/content/0/${n}/slides.pdf`;
    const result = await downloadMoodleFiles(client({
      getActivity: async () => ({ id: 5, type: "folder", url: `${BASE_URL}/mod/folder/view.php?id=5`, file_entries: [
        { name: "slides.pdf", url: file(1), requires_authentication: true },
        { name: "notes.pdf", url: file(2), requires_authentication: true },
      ] }) as never,
      requestAbsolute: async (url: string) => responseAt(url, "%PDF", { "content-type": "application/pdf" }),
    }), { source: `${BASE_URL}/mod/folder/view.php?id=5`, directory, dryRun: true });

    expect(result).toMatchObject({ dry_run: true, total: 2, files: [{ filename: "slides.pdf", bytes_written: 0 }, { filename: "notes.pdf", bytes_written: 0 }] });
    await expect(readdir(directory)).rejects.toThrow();
    expect(formatDownloadResult(result, directory)).toBe("Would save 2 files → .\n  slides.pdf\n  notes.pdf");
  });

  it("saves one document linked twice under different URLs once, now and on a rerun", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const file = (n: number) => `${BASE_URL}/pluginfile.php/${n}/brief.pdf`;
    const folder = client({
      getActivity: async () => ({ id: 5, type: "folder", file_entries: [1, 2].map(n => ({ name: "brief.pdf", url: file(n), requires_authentication: true })) }) as never,
      requestAbsolute: async (url: string) => responseAt(url, "same", { "content-type": "application/pdf" }),
    });
    expect((await downloadMoodleFiles(folder, { source: "5", directory })).files.map(f => f.filename)).toEqual(["brief.pdf"]);
    expect(await downloadMoodleFiles(folder, { source: "5", directory })).toMatchObject({ files: [], skipped: [{ name: "brief.pdf", reason: "exists" }] });
    await expect(readdir(directory)).resolves.toEqual(["brief.pdf"]);
  });

  it("downloads an assignment's attached files from its activity URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const spec = `${BASE_URL}/pluginfile.php/9/mod_assign/introattachment/0/spec.pdf?forcedownload=1`;
    const data = `${BASE_URL}/pluginfile.php/9/mod_assign/introattachment/0/data.csv?forcedownload=1`;
    const result = await downloadMoodleFiles(client({
      getActivity: async () => ({ id: 77, type: "assign", url: `${BASE_URL}/mod/assign/view.php?id=77`, file_entries: [
        { name: "spec.pdf", url: spec, requires_authentication: true },
        { name: "data.csv", url: data, requires_authentication: true },
      ] }) as never,
      requestAbsolute: async (url: string) => responseAt(url, "x", { "content-disposition": "attachment" }),
    }), { source: `${BASE_URL}/mod/assign/view.php?id=77`, directory });

    expect(result.files.map(f => f.filename)).toEqual(["spec.pdf", "data.csv"]);
  });

  it("downloads what a section's page shows, including a nested child section", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const sectionUrl = `${BASE_URL}/course/view.php?id=100&section=3`;
    const page = sectionHtml(3, "Week 3", cm(1, "resource") + cm(2, "assign") + cm(3, "forum") + sectionHtml(4, "Real-time", cm(4, "resource") + cm(1, "resource")));
    const getActivity = vi.fn(async (id: number) => ({
      id, type: id === 2 ? "assign" : "resource", url: `${BASE_URL}/mod/x/view.php?id=${id}`,
      file_entries: id === 2 ? [] : [{ name: `f${id}.pdf`, url: `${BASE_URL}/pluginfile.php/${id}/f.pdf`, requires_authentication: true }],
    }) as never);
    const result = await downloadMoodleFiles(client({
      getActivity,
      requestAbsolute: async (url: string) => url === sectionUrl
        ? responseAt(url, page, { "content-type": "text/html" })
        : responseAt(url, "x", { "content-disposition": "attachment" }),
    }), { source: sectionUrl, directory });

    expect(getActivity.mock.calls.map(([id]) => id)).toEqual([1, 2, 4]);
    expect(result.files.map(f => f.filename)).toEqual(["f1.pdf", "f4.pdf"]);
  });

  it("skips a broken file, an unavailable activity and a repeat, and keeps the rest of the section", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const sectionUrl = `${BASE_URL}/course/view.php?id=100&section=3`;
    // A shortcut ("shadow") in the section names the real assignment through its link.
    const shadow = `<li class="activity activity-wrapper shadow modtype_shadow" id="module-9" data-for="cmitem" data-id="9"><div class="activityname"><a href="${BASE_URL}/mod/assign/view.php?id=2"><span class="instancename">Essay</span></a></div></li>`;
    const page = sectionHtml(3, "Week 3", cm(1, "folder") + cm(2, "assign") + shadow + cm(5, "resource"));
    const file = (name: string) => ({ name, url: `${BASE_URL}/pluginfile.php/1/${name}`, requires_authentication: true });
    const getActivity = vi.fn(async (id: number) => {
      if (id === 5) throw new NotFoundError("Activity 5 is not available to you.");
      return { id, type: id === 1 ? "folder" : "assign", url: `${BASE_URL}/mod/x/view.php?id=${id}`, file_entries: id === 1
        ? [file("Slides.pdf"), file("gone.pdf"), file("slides.pdf")]
        : [file("Slides.pdf")] } as never;
    });
    const result = await downloadMoodleFiles(client({
      getActivity,
      requestAbsolute: async (url: string) => url === sectionUrl
        ? responseAt(url, page, { "content-type": "text/html" })
        : url.endsWith("gone.pdf")
          ? responseAt(url, "<p>Sorry, the requested file could not be found</p>", { "content-type": "text/html" })
          : responseAt(url, url.slice(-10), { "content-disposition": "attachment" }),
    }), { source: sectionUrl, directory });

    expect(getActivity.mock.calls.map(([id]) => id)).toEqual([1, 2, 5]);
    // The assignment links the folder's first file again, so it is saved once; case never collides.
    expect(result.files.map(f => f.filename)).toEqual(["Slides.pdf", "slides (2).pdf"]);
    expect(result.skipped.map(s => `${s.reason} ${s.name}`)).toEqual(["unavailable a5", "unavailable gone.pdf"]);
  });

  it("skips a file Moodle gives no name for, and saves one to --dest anyway", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const nameless = `${BASE_URL}/pluginfile.php/7/mod_folder/content/0/`;
    const folder = client({
      getActivity: async () => ({ id: 5, type: "folder", url: `${BASE_URL}/mod/folder/view.php?id=5`, file_entries: [
        { name: "a.pdf", url: `${BASE_URL}/pluginfile.php/7/mod_folder/content/0/a.pdf`, requires_authentication: true },
        { name: "", url: nameless, requires_authentication: true },
      ] }) as never,
      requestAbsolute: async (url: string) => responseAt(url, "%PDF", { "content-type": "application/pdf" }),
    });
    const result = await downloadMoodleFiles(folder, { source: `${BASE_URL}/mod/folder/view.php?id=5`, directory });
    expect(result.files.map(f => f.filename)).toEqual(["a.pdf"]);
    expect(result.skipped).toMatchObject([{ reason: "unavailable", detail: "Moodle did not provide a safe filename." }]);

    const destination = join(directory, "named-here.pdf");
    const single = client({ requestAbsolute: async (url: string) => responseAt(url, "%PDF", { "content-type": "application/pdf" }) });
    await expect(downloadMoodleFile(single, { source: nameless, destination })).resolves.toMatchObject({ filename: "named-here.pdf" });
  });

  it("reads a section linked by its id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    const sectionUrl = `${BASE_URL}/course/section.php?id=44`;
    const result = await downloadMoodleFiles(client({
      getActivity: async (id: number) => ({ id, type: "resource", file_entries: [{ name: "f.pdf", url: `${BASE_URL}/pluginfile.php/1/f.pdf`, requires_authentication: true }] }) as never,
      requestAbsolute: async (url: string) => url === sectionUrl
        ? responseAt(url, sectionHtml(4, "Week 4", cm(1, "resource")), { "content-type": "text/html" })
        : responseAt(url, "x", { "content-disposition": "attachment" }),
    }), { source: sectionUrl, directory });
    expect(result.files.map(f => f.filename)).toEqual(["f.pdf"]);
  });

  it("refuses --dest with --to, and --dest naming a directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-"));
    await expect(downloadMoodleFiles(client({}), { source: "5", destination: join(directory, "a.pdf"), directory }))
      .rejects.toMatchObject({ code: "usage" });
    await expect(downloadMoodleFiles(client({}), { source: "5", destination: directory }))
      .rejects.toMatchObject({ code: "usage", hint: `Pass --to ${directory} to save into it.` });
  });

  it("refuses --dest for a source with several files and a course URL without a section", async () => {
    const getActivity = async () => ({ id: 5, type: "folder", file_entries: [
      { name: "a.pdf", url: `${BASE_URL}/pluginfile.php/1/a.pdf`, requires_authentication: true },
      { name: "b.pdf", url: `${BASE_URL}/pluginfile.php/1/b.pdf`, requires_authentication: true },
    ] }) as never;
    await expect(downloadMoodleFiles(client({ getActivity }), { source: "5", destination: join(tmpdir(), "x.pdf") }))
      .rejects.toMatchObject({ code: "usage", hint: expect.stringContaining("--to") });
    await expect(downloadMoodleFiles(client({}), { source: `${BASE_URL}/course/view.php?id=100` }))
      .rejects.toMatchObject({ code: "usage" });
  });

  it.each(["download", "dl"])("exposes %s with one JSON receipt on non-TTY stdout", async (command) => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-download-cli-"));
    const destination = join(directory, `${command}.pdf`);
    const source = `${BASE_URL}/pluginfile.php/1/slides.pdf`;
    const result = await runDownloadCli([command, source, "--dest", destination], source);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).files[0]).toMatchObject({
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
    expect(download).toMatchObject({ aliases: ["dl", "get"], mutating: false });

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
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ files: [{ file_path: destination }], total: 1 });
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

function cm(id: number, modname: string): string {
  return `<li class="activity activity-wrapper ${modname} modtype_${modname}" id="module-${id}" data-for="cmitem" data-id="${id}"><div class="activityname"><a href="${BASE_URL}/mod/${modname}/view.php?id=${id}"><span class="instancename">a${id}</span></a></div></li>`;
}

function sectionHtml(number: number, name: string, inner: string): string {
  return `<li id="section-${number}" class="section course-section main" data-for="section" data-id="${40 + number}" data-number="${number}"><h3 class="sectionname">${name}</h3><ul class="section">${inner}</ul></li>`;
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

describe("download receipt screen", () => {
  const receipt = (file_path: string, bytes_written: number) => ({ file_path, filename: file_path.split("/").at(-1)!, bytes_written, content_type: "application/pdf", source_url: "", final_url: "" });

  it("prints one line for one file, relative to the working directory", () => {
    expect(formatDownloadResult({ files: [receipt("/work/Lecture 5.pdf", 8906445)], skipped: [], total: 1 }, "/work"))
      .toBe("✓ Saved Lecture 5.pdf (8.5 MiB) → ./Lecture 5.pdf");
    expect(formatDownloadResult({ files: [receipt("/elsewhere/a.pdf", 10)], skipped: [], total: 1 }, "/work"))
      .toBe("✓ Saved a.pdf (10 B) → /elsewhere/a.pdf");
  });

  it("says what was already there and what Moodle would not provide", () => {
    const skip = (name: string, reason: "exists" | "unavailable", detail?: string) => ({ name, reason, source_url: "", file_path: `/work/w5/${name}`, ...(detail ? { detail } : {}) });
    expect(formatDownloadResult({ files: [], skipped: [skip("a.pdf", "exists")], total: 0 }, "/work"))
      .toBe("✓ Already have a.pdf → ./w5/a.pdf; --force downloads it again.");
    expect(formatDownloadResult({ files: [receipt("/work/w5/c.pdf", 1)], skipped: [skip("a.pdf", "exists"), skip("b.pdf", "exists"), skip("Quiz notes", "unavailable", "Activity 5 is not available to you.")], total: 1 }, "/work"))
      .toBe("✓ Saved c.pdf (1 B) → ./w5/c.pdf\n2 files were already in ./w5; --force downloads them again.\n! Skipped Quiz notes: Activity 5 is not available to you.");
    expect(formatDownloadResult({ files: [], skipped: [skip("a.pdf", "exists"), skip("b.pdf", "exists")], total: 0 }, "/work/w5"))
      .toBe("✓ 2 files were already here; --force downloads them again.");
    expect(formatDownloadResult({ files: [], skipped: [skip("gone.pdf", "unavailable")], total: 0 }, "/work"))
      .toBe("Saved nothing.\n! Skipped gone.pdf: Moodle did not provide it.");
  });

  it("titles a batch with its count, size and folder", () => {
    const text = formatDownloadResult({ files: [receipt("/work/w5/a.pdf", 2048), receipt("/work/w5/b.csv", 1024)], skipped: [], total: 2 }, "/work");
    expect(text).toContain("✓ Saved 2 files (3.0 KiB) → ./w5");
    expect(text).toContain("b.csv");
  });
});
