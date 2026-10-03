import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MoodleClient } from "../src/client.js";
import { CliError } from "../src/errors.js";
import { formatSyncResult } from "../src/formatters.js";
import type { Activity, Course, Section } from "../src/models.js";
import { MANIFEST_NAME, pathSegment, sectionDirectories, storedPath, syncUnits } from "../src/sync.js";

// exFAT/FAT drives and some network shares refuse hard links; a test can switch that on.
const disk = vi.hoisted(() => ({ hardLinks: true }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (!disk.hardLinks) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return actual.link(...args);
    },
  };
});
afterEach(() => {
  disk.hardLinks = true;
});

const BASE_URL = "https://school.example.edu";
const COURSE: Course = { id: 100, shortname: "UNIT1001", fullname: "Unit One", category: 1, visible: true, startdate: 0 };
const NOW = () => new Date(2026, 8, 27);

// A small Moodle: one nested section holding a resource, a folder and an assignment.
// Files live in `files` keyed by URL; the resource page names its file the way
// forceview renders it. Every request is logged so tests can see what a rerun asks.
function site() {
  const files = new Map<string, { body: string; etag: string; type: string }>();
  const put = (url: string, body: string, type = "application/octet-stream") => files.set(url, { body, type, etag: `"${createHash("sha1").update(body).digest("hex")}"` });
  const slides = (revision: number, name = "slides.pdf") => `${BASE_URL}/pluginfile.php/11/mod_resource/content/${revision}/${name}`;
  const state = { resourceFile: slides(1), folderFiles: [] as string[], assignFiles: [] as string[], activities: [] as Activity[], pages: new Map<string, () => string>() };
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];

  put(state.resourceFile, "slides v1");
  state.folderFiles = [`${BASE_URL}/pluginfile.php/12/mod_folder/content/0/data/week1.csv?forcedownload=1`];
  put(state.folderFiles[0], "a,b");
  state.assignFiles = [`${BASE_URL}/pluginfile.php/13/mod_assign/introattachment/0/brief.pdf?forcedownload=1`];
  put(state.assignFiles[0], "brief");
  state.activities = [activity(1, "resource", "Lecture 1"), activity(2, "folder", "Lab data"), activity(3, "assign", "Assignment 1: Regex"), activity(4, "forum", "Forum")];

  const client = {
    baseUrl: BASE_URL,
    getCourseContents: async (): Promise<Section[]> => [
      { id: 10, name: "Week 1", section: 1, visible: true, summary: "", activities: [] },
      { id: 11, name: "Real-time", section: 2, visible: true, summary: "", parent: 10, activities: state.activities },
    ],
    getFolder: async () => ({ file_entries: state.folderFiles.map((url) => ({ name: "week1.csv", url, requires_authentication: true })) }),
    getAssignment: async () => ({ file_entries: state.assignFiles.map((url) => ({ name: "brief.pdf", url, requires_authentication: true })) }),
    requestAbsolute: async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      requests.push({ url, headers });
      const page = state.pages.get(url);
      if (page) return at(url, page(), { "content-type": "text/html; charset=utf-8" });
      if (url.includes("/mod/resource/view.php")) {
        return at(url, `<div class="resourceworkaround"><a href="${state.resourceFile}">slides.pdf</a></div>`, { "content-type": "text/html" });
      }
      const file = files.get(url);
      if (!file) return new Response("missing", { status: 404 });
      if (headers["if-none-match"] === file.etag) return new Response(null, { status: 304 });
      return at(url, file.body, { "content-type": file.type, etag: file.etag });
    },
  } as unknown as MoodleClient;
  return { client, files, put, slides, state, requests };
}

function activity(id: number, modname: string, name: string): Activity {
  return { id, name, modname, url: `${BASE_URL}/mod/${modname}/view.php?id=${id}`, visible: true, description: "" };
}

function at(url: string, body: BodyInit | null, headers: HeadersInit = {}): Response {
  const response = new Response(body, { headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "moodle-sync-"));
}

const unitDir = (base: string) => join(base, "UNIT1001");
const lecture = (base: string) => join(unitDir(base), "Week 1", "Real-time", "slides.pdf");

describe("moodle sync", () => {
  it("mirrors a unit into nested section folders, then asks again with conditional requests", async () => {
    const moodle = site();
    const base = await root();

    const first = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(first.units[0].changes.map((change) => [change.status, change.path.slice(unitDir(base).length + 1)])).toEqual([
      ["new", "Week 1/Real-time/Assignment 1 Regex/brief.pdf"],
      ["new", "Week 1/Real-time/Lab data/data/week1.csv"],
      ["new", "Week 1/Real-time/slides.pdf"],
    ]);
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("slides v1");
    const manifest = JSON.parse(await readFile(join(unitDir(base), MANIFEST_NAME), "utf8"));
    expect(Object.keys(manifest.files).sort()).toEqual([
      "cm:1",
      "cm:2/mod_folder/content/data/week1.csv",
      "cm:3/mod_assign/introattachment/0/brief.pdf",
    ]);

    moodle.requests.length = 0;
    const second = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(second.units[0]).toMatchObject({ changes: [], unchanged: 3, problems: [] });
    // The resource page is read once; later runs ask for the stored file directly.
    expect(moodle.requests.some((request) => request.url.includes("/mod/resource/view.php"))).toBe(false);
    expect(moodle.requests.every((request) => request.headers["if-none-match"])).toBe(true);
  });

  it("replaces an untouched copy when Moodle changes the file", async () => {
    const moodle = site();
    const base = await root();
    await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    moodle.put(moodle.state.resourceFile, "slides v2");
    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(result.units[0].changes).toEqual([{ status: "updated", path: lecture(base), bytes: 9 }]);
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("slides v2");
  });

  it("never overwrites a file you edited; the new version lands beside it", async () => {
    const moodle = site();
    const base = await root();
    await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    await writeFile(lecture(base), "slides v1 + my notes");

    moodle.put(moodle.state.resourceFile, "slides v2");
    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    const beside = join(unitDir(base), "Week 1", "Real-time", "slides (updated 2026-09-27).pdf");

    expect(result.units[0].changes).toEqual([{ status: "conflict", path: beside, bytes: 9, edited: lecture(base) }]);
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("slides v1 + my notes");
    await expect(readFile(beside, "utf8")).resolves.toBe("slides v2");

    // The manifest now follows the new file, so your copy is never touched again.
    moodle.put(moodle.state.resourceFile, "slides v3");
    const next = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(next.units[0].changes).toEqual([{ status: "updated", path: beside, bytes: 9 }]);
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("slides v1 + my notes");
  });

  it("treats the same bytes at a new revision as unchanged", async () => {
    const moodle = site();
    const base = await root();
    await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    // A settings edit bumps the revision; the stored URL now fails and the page names a new one.
    moodle.files.delete(moodle.state.resourceFile);
    moodle.state.resourceFile = moodle.slides(2);
    moodle.put(moodle.state.resourceFile, "slides v1");
    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(result.units[0]).toMatchObject({ changes: [], unchanged: 3 });
    const manifest = JSON.parse(await readFile(join(unitDir(base), MANIFEST_NAME), "utf8"));
    expect(manifest.files["cm:1"].url).toBe(moodle.slides(2));
  });

  it("follows a resource whose file was replaced under a new name", async () => {
    const moodle = site();
    const base = await root();
    await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    moodle.files.delete(moodle.state.resourceFile);
    moodle.state.resourceFile = moodle.slides(2, "slides-final.pdf");
    moodle.put(moodle.state.resourceFile, "final slides");
    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    const renamed = join(unitDir(base), "Week 1", "Real-time", "slides-final.pdf");

    expect(result.units[0].changes).toEqual([{ status: "updated", path: renamed, bytes: 12 }]);
    await expect(readdir(join(unitDir(base), "Week 1", "Real-time"))).resolves.not.toContain("slides.pdf");
  });

  it("saves a page and a book as HTML, and rewrites them only when what they show changes", async () => {
    const moodle = site();
    const base = await root();
    const pageFile = join(unitDir(base), "Week 1", "Real-time", "Reading list.html");
    const bookFile = join(unitDir(base), "Week 1", "Real-time", "Study guide.html");
    const bookUrl = `${BASE_URL}/mod/book/tool/print/index.php?id=6`;
    let printed = 0;
    // The print view stamps the reader and the time on every request.
    const book = (chapter: string) => () => `<html><body><div role="main"><div class="book">
      <div class="text-end"><a class="hidden-print" href="#" onclick="window.print()">Print book</a></div>
      <div class="book_info">Printed by: Someone · Date: ${++printed}</div>
      <div class="book_chapter"><h2>One</h2><p>${chapter}</p><img src="/pluginfile.php/15/mod_book/chapter/1/diagram.png" alt="diagram"></div>
    </div></div></body></html>`;
    moodle.put(`${BASE_URL}/pluginfile.php/15/mod_book/chapter/1/diagram.png`, "PNG", "image/png");
    moodle.state.activities.push(activity(5, "page", "Reading list"), activity(6, "book", "Study guide"));
    moodle.state.pages.set(`${BASE_URL}/mod/page/view.php?id=5`, () => `<html><body><div role="main"><div class="box generalbox">
      <p>Read <a href="/mod/url/view.php?id=9">this</a> first.</p><script>window.location = "https://elsewhere.example";</script>
    </div></div></body></html>`);
    moodle.state.pages.set(bookUrl, book("First draft"));

    const first = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(first.units[0].changes.filter((change) => change.path.endsWith(".html")).map((change) => [change.status, change.path])).toEqual([
      ["new", pageFile],
      ["new", bookFile],
    ]);
    const savedPage = await readFile(pageFile, "utf8");
    expect(savedPage).toContain("<title>Reading list</title>");
    expect(savedPage).toContain(`href="${BASE_URL}/mod/url/view.php?id=9"`);
    expect(savedPage).not.toContain("<script");
    const savedBook = await readFile(bookFile, "utf8");
    expect(savedBook).toContain(`src="data:image/png;base64,${Buffer.from("PNG").toString("base64")}"`);
    expect(savedBook).not.toContain("Printed by");
    expect(savedBook).not.toContain("onclick");

    const second = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(second.units[0]).toMatchObject({ changes: [], unchanged: 5, problems: [] });

    moodle.state.pages.set(bookUrl, book("Second draft"));
    const third = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(third.units[0].changes).toEqual([{ status: "updated", path: bookFile, bytes: expect.any(Number) }]);
    await expect(readFile(bookFile, "utf8")).resolves.toContain("Second draft");
  });

  it("reports a file gone from Moodle once and keeps the local copy", async () => {
    const moodle = site();
    const base = await root();
    await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    moodle.state.activities = moodle.state.activities.filter((item) => item.id !== 1);
    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(result.units[0].changes).toEqual([{ status: "removed", path: lecture(base) }]);
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("slides v1");
    expect((await syncUnits(moodle.client, [COURSE], { root: base, now: NOW })).units[0].changes).toEqual([]);
  });

  it("keeps the files of an activity it could not read out of the removed list", async () => {
    const moodle = site();
    const base = await root();
    await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    (moodle.client as unknown as { getFolder: () => Promise<never> }).getFolder = async () => {
      throw new Error("HTTP 503 loading the folder");
    };
    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(result.units[0].changes).toEqual([]);
    expect(result.units[0].problems).toEqual([{ item: "Lab data", message: "HTTP 503 loading the folder" }]);
  });

  it("writes nothing on a dry run", async () => {
    const moodle = site();
    const base = await root();

    const result = await syncUnits(moodle.client, [COURSE], { root: base, dryRun: true, now: NOW });

    expect(result.dry_run).toBe(true);
    expect(result.units[0].changes.map((change) => change.status)).toEqual(["new", "new", "new"]);
    await expect(readdir(base)).resolves.toEqual([]);
  });

  it("adopts an identical file already in place and sidesteps a different one", async () => {
    const moodle = site();
    const base = await root();
    await mkdir(join(unitDir(base), "Week 1", "Real-time", "Lab data", "data"), { recursive: true });
    await writeFile(lecture(base), "someone else's slides");
    await writeFile(join(unitDir(base), "Week 1", "Real-time", "Lab data", "data", "week1.csv"), "a,b");

    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(result.units[0].changes.map((change) => change.path.slice(unitDir(base).length + 1))).toEqual([
      "Week 1/Real-time/Assignment 1 Regex/brief.pdf",
      "Week 1/Real-time/slides (2).pdf",
    ]);
    expect(result.units[0].unchanged).toBe(1);
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("someone else's slides");

    // A later version updates the sidestepped copy in place rather than walking to "(3)".
    moodle.put(moodle.state.resourceFile, "slides v2");
    const next = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(next.units[0].changes).toEqual([{ status: "updated", path: join(unitDir(base), "Week 1", "Real-time", "slides (2).pdf"), bytes: 9 }]);
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("someone else's slides");
  });

  it("finds a renamed unit folder by its manifest", async () => {
    const moodle = site();
    const base = await root();
    await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    await rename(unitDir(base), join(base, "Theory"));

    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(result.units[0]).toMatchObject({ directory: join(base, "Theory"), changes: [], unchanged: 3 });
    await expect(readdir(base)).resolves.toEqual(["Theory"]);
  });

  it("leaves a file you deleted alone until Moodle changes it", async () => {
    const moodle = site();
    const base = await root();
    await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    await unlink(lecture(base));

    const unchanged = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(unchanged.units[0]).toMatchObject({ changes: [], unchanged: 3, problems: [] });
    await expect(readdir(join(unitDir(base), "Week 1", "Real-time"))).resolves.not.toContain("slides.pdf");

    moodle.put(moodle.state.resourceFile, "slides v2");
    const changed = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(changed.units[0].changes).toEqual([{ status: "updated", path: lecture(base), bytes: 9 }]);
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("slides v2");
  });

  it("records files already replaced when a run stops on a fatal error", async () => {
    const moodle = site();
    const base = await root();
    await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    moodle.put(moodle.state.resourceFile, "slides v2");
    const request = moodle.client.requestAbsolute.bind(moodle.client);
    // The resource is still downloading when the folder finds the session gone.
    moodle.client.requestAbsolute = async (url, init, options) => {
      if (url === moodle.state.resourceFile) await new Promise((resolve) => setTimeout(resolve, 20));
      return request(url, init, options);
    };
    const getFolder = moodle.client.getFolder;
    moodle.client.getFolder = async () => {
      throw new CliError("auth", "Session expired.");
    };
    await expect(syncUnits(moodle.client, [COURSE], { root: base, now: NOW })).rejects.toMatchObject({ code: "auth" });
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("slides v2");

    // The replaced copy is still pristine, so the next version replaces it again.
    moodle.client.getFolder = getFolder;
    moodle.put(moodle.state.resourceFile, "slides v3");
    const next = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(next.units[0].changes).toEqual([{ status: "updated", path: lecture(base), bytes: 9 }]);
    await expect(readdir(join(unitDir(base), "Week 1", "Real-time"))).resolves.toEqual(expect.not.arrayContaining([expect.stringContaining("(updated")]));
  });

  it("reports a unit it cannot read and goes on to the next", async () => {
    const moodle = site();
    const base = await root();
    const other = { ...COURSE, id: 200, shortname: "UNIT2002" };
    const getCourseContents = moodle.client.getCourseContents.bind(moodle.client);
    moodle.client.getCourseContents = async (id: number) => {
      if (id === COURSE.id) throw new CliError("upstream", "Moodle answered HTTP 503.");
      return getCourseContents(id);
    };

    const result = await syncUnits(moodle.client, [COURSE, other], { root: base, now: NOW });

    expect(result.units[0]).toMatchObject({ unit: "UNIT1001", changes: [], problems: [{ item: "UNIT1001", message: "Moodle answered HTTP 503." }] });
    expect(result.units[1].changes).toHaveLength(3);

    moodle.client.getCourseContents = async () => {
      throw new CliError("auth", "Session expired.");
    };
    await expect(syncUnits(moodle.client, [COURSE, other], { root: base, now: NOW })).rejects.toMatchObject({ code: "auth" });
  });

  it("copies instead of linking on a disk without hard links, still never over an existing file", async () => {
    const moodle = site();
    const base = await root();
    disk.hardLinks = false;
    await mkdir(join(unitDir(base), "Week 1", "Real-time"), { recursive: true });
    await writeFile(lecture(base), "someone else's slides");

    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(result.units[0]).toMatchObject({ problems: [] });
    expect(result.units[0].changes.map((change) => change.status)).toEqual(["new", "new", "new"]);
    await expect(readFile(lecture(base), "utf8")).resolves.toBe("someone else's slides");
    await expect(readFile(join(unitDir(base), "Week 1", "Real-time", "slides (2).pdf"), "utf8")).resolves.toBe("slides v1");
    expect((await readdir(unitDir(base), { recursive: true })).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps hostile and reserved names inside the unit folder", async () => {
    const moodle = site();
    const base = await root();
    moodle.state.activities = [activity(2, "folder", "AUX"), activity(3, "assign", "../../Assignment")];
    moodle.client.getFolder = async () => ({
      file_entries: [
        { name: "../../escape.csv", url: `${BASE_URL}/pluginfile.php/12/mod_folder/content/0/..%2F..%2Fout/escape.csv`, requires_authentication: true },
        { name: "CON.csv", url: `${BASE_URL}/pluginfile.php/12/mod_folder/content/0/nul/CON.csv`, requires_authentication: true },
      ],
    }) as never;
    moodle.client.getAssignment = async () => ({ file_entries: [{ name: "..", url: `${BASE_URL}/pluginfile.php/13/mod_assign/introattachment/0/..%2Fbrief.pdf`, requires_authentication: true }] }) as never;
    for (const entry of [...(await moodle.client.getFolder(2)).file_entries, ...(await moodle.client.getAssignment(3)).file_entries]) moodle.put(entry.url, entry.name);

    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });

    expect(result.units[0].problems).toEqual([]);
    expect(result.units[0].changes).toHaveLength(3);
    for (const change of result.units[0].changes) expect(change.path.startsWith(unitDir(base) + sep)).toBe(true);
    expect(await readdir(base)).toEqual(["UNIT1001"]);
    const written = (await readdir(unitDir(base), { recursive: true })).flatMap((name) => name.split(sep));
    expect(written.filter((segment) => /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/iu.test(segment))).toEqual([]);
  });
});

describe("sync paths", () => {
  it("keys a stored file without its context or revision", () => {
    expect(storedPath(`${BASE_URL}/pluginfile.php/7/mod_folder/content/4/sub%20dir/a.pdf?forcedownload=1`)).toEqual(["mod_folder", "content", "sub dir", "a.pdf"]);
    expect(storedPath(`${BASE_URL}/pluginfile.php/7/mod_assign/introattachment/0/brief.pdf`)).toEqual(["mod_assign", "introattachment", "0", "brief.pdf"]);
    expect(storedPath(`${BASE_URL}/mod/resource/view.php?id=1`)).toBeUndefined();
  });

  it("turns Moodle names into safe folder names", () => {
    expect(pathSegment("Week 1: Logic / Linux")).toBe("Week 1 Logic - Linux");
    expect(pathSegment(".hidden.")).toBe("hidden");
    expect(pathSegment("")).toBe("_");
    expect(["CON", "nul", "Aux.notes", "COM1", "lpt9.x", "CONSOLE", "COM0"].map(pathSegment)).toEqual(["CON_", "nul_", "Aux_.notes", "COM1_", "lpt9_.x", "CONSOLE", "COM0"]);
  });

  it("nests child sections under their parent", () => {
    const section = (id: number, name: string, parent?: number): Section => ({ id, name, section: id, visible: true, summary: "", activities: [], ...(parent ? { parent } : {}) });
    expect([...sectionDirectories([section(1, "Learning"), section(2, "Week 1", 1), section(3, "Own-time", 2), section(4, "")]).values()])
      .toEqual(["Learning", "Learning/Week 1", "Learning/Week 1/Own-time", "Section 4"]);
  });
});

describe("sync receipt", () => {
  const unit = { unit_id: 1, unit: "UNIT1001", directory: "/work/UNIT1001", unchanged: 4, problems: [] };

  it("says a unit is up to date in one line", () => {
    expect(formatSyncResult({ dry_run: false, units: [{ ...unit, changes: [] }] }, "/work")).toBe("✓ UNIT1001 → ./UNIT1001 · up to date · 4 unchanged");
  });

  it("lists what changed and collapses a long run of new files", () => {
    const text = formatSyncResult({ dry_run: false, units: [{
      ...unit,
      changes: [
        ...Array.from({ length: 16 }, (_, index) => ({ status: "new" as const, path: `/work/UNIT1001/f${index}.pdf`, bytes: 1024 })),
        { status: "conflict", path: "/work/UNIT1001/a (updated 2026-09-27).pdf", bytes: 1, edited: "/work/UNIT1001/a.pdf" },
        { status: "removed", path: "/work/UNIT1001/old.pdf" },
      ],
      problems: [{ item: "Lab data", message: "HTTP 503" }],
    }] }, "/work");
    expect(text).toContain("! UNIT1001 → ./UNIT1001 · 16 new, 1 kept your edits, 1 gone from Moodle, 1 failed · 4 unchanged");
    expect(text).toContain("  + 16 files (16.0 KiB)");
    expect(text).toContain("  ! a.pdf changed on Moodle; yours is kept, the new one is a (updated 2026-09-27).pdf");
    expect(text).toContain("  − old.pdf is gone from Moodle; your copy stays");
    expect(text).toContain("  ✗ Lab data: HTTP 503");
  });
  it("keeps separate ledgers for unit names that sanitize to the same folder", async () => {
    const moodle = site();
    const base = await root();
    const firstCourse = { ...COURSE, shortname: "UNIT:1001" };
    const secondCourse = { ...COURSE, id: 200, shortname: "UNIT1001" };
    const first = await syncUnits(moodle.client, [firstCourse], { root: base, now: NOW });
    const second = await syncUnits(moodle.client, [secondCourse], { root: base, now: NOW });
    expect(first.units[0].directory).not.toBe(second.units[0].directory);
    for (const [result, id] of [[first, 100], [second, 200]] as const) {
      const ledger = JSON.parse(await readFile(join(result.units[0].directory, MANIFEST_NAME), "utf8"));
      expect(ledger.unit_id).toBe(id);
    }
    moodle.put(moodle.state.resourceFile, "slides v2");
    const next = await syncUnits(moodle.client, [firstCourse], { root: base, now: NOW });
    expect(next.units[0].changes).toEqual([{ status: "updated", path: lecture(base), bytes: 9 }]);
    expect(await readFile(lecture(base), "utf8")).toBe("slides v2");
    const repeated = await syncUnits(moodle.client, [secondCourse], { root: base, now: NOW });
    expect(repeated.units[0].directory).toBe(second.units[0].directory);
  });

  it("updates embedded images even when their Moodle URLs stay unchanged", async () => {
    const moodle = site();
    const base = await root();
    const page = `${BASE_URL}/mod/page/view.php?id=5`;
    const image = `${BASE_URL}/pluginfile.php/15/mod_page/content/1/diagram.png`;
    moodle.state.activities = [activity(5, "page", "Picture")];
    moodle.state.pages.set(page, () => `<div role="main"><p>Diagram</p><img src="${image}"></div>`);
    moodle.put(image, "PNG_V1", "image/png");
    const first = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    const filename = first.units[0].changes[0].path;
    moodle.put(image, "PNG_V2", "image/png");
    const second = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(second.units[0]).toMatchObject({ unchanged: 0, problems: [], changes: [{ status: "updated", path: filename }] });
    const saved = await readFile(filename, "utf8");
    expect(saved).toContain(Buffer.from("PNG_V2").toString("base64"));
    expect(saved).not.toContain(Buffer.from("PNG_V1").toString("base64"));
    const third = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(third.units[0]).toMatchObject({ unchanged: 1, changes: [] });
  });

  it("retries a dropped download body without keeping the partial file", async () => {
    const moodle = site();
    const base = await root();
    moodle.state.activities = [activity(1, "resource", "Lecture")];
    const request = moodle.client.requestAbsolute.bind(moodle.client);
    let attempts = 0;
    moodle.client.requestAbsolute = async (url, init, options) => {
      if (url === moodle.state.resourceFile && ++attempts === 1) {
        return at(url, new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); controller.error(new Error("connection reset")); } }), { "content-type": "application/pdf" });
      }
      return request(url, init, options);
    };
    const result = await syncUnits(moodle.client, [COURSE], { root: base, now: NOW });
    expect(attempts).toBe(2);
    expect(result.units[0]).toMatchObject({ problems: [], changes: [{ status: "new", path: lecture(base) }] });
    expect(await readFile(lecture(base), "utf8")).toBe("slides v1");
    expect(await readdir(join(unitDir(base), "Week 1", "Real-time"))).toEqual(["slides.pdf"]);
  });

});
