import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { runCli } from "../src/cli.js";

import { describe, expect, it } from "vitest";

import { MoodleClient } from "../src/client.js";
import { readFileSync } from "node:fs";
import { MoodleAPIError, UsageError } from "../src/errors.js";
import { intentContracts } from "../src/intent-contract.js";
import { formatSubmissionReceipt } from "../src/formatters.js";
import { parseSubmissionForm, submissionReceiptOf, submitAssignmentFiles, type AssignSubmitDeps, type SubmitAssignmentRequest } from "../src/moodle-assign-core.js";
import { stripEmpty } from "../src/results.js";
import { readSubmissionFiles } from "../src/submit.js";

const BASE = "https://school.example.edu";
const VIEW = `${BASE}/mod/assign/view.php?id=555`;
const ITEMID = "640000123";
const STATEMENT = "This submission is my own work, except where I have acknowledged the use of the works of other people.";

describe("assignment submission flow", () => {
  it("asks consent for both files and online text before a mixed submission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-submit-consent-"));
    await writeFile(join(directory, "essay.pdf"), "hello");
    const site = fakeSite({ onlineText: true });
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    let output = "";
    let declined = false;
    const stderr = new Writable({ write(chunk, _encoding, callback) {
      output += String(chunk);
      if (!declined && output.includes("Continue?")) {
        declined = true;
        setImmediate(() => input.write("n\r"));
      }
      callback();
    } });
    const stdout = { isTTY: true, write: () => true };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (new URL(url).pathname === "/my/") return page(url, readFileSync(new URL("./fixtures/dashboard.html", import.meta.url), "utf8"));
      if (url.includes("/lib/ajax/service.php")) return json(url, [{ error: true, exception: { errorcode: "invalidrecord", message: "Unavailable" } }]);
      return site.deps.request(url, init);
    };

    const code = await runCli(["node", "moodle", "submit", "555", "essay.pdf", "--text", "Updated reflection", "--table"], {
      cwd: directory, homeDir: directory, env: { MOODLE_BASE_URL: BASE, MOODLE_SESSION: "fixture", MOODLE_NO_UPDATE_CHECK: "1" },
      fetchImpl, stdin: input as unknown as NodeJS.ReadStream, stdout, stderr,
    });

    expect(code, output).toBe(0);
    expect(output).toContain("essay.pdf");
    expect(output).toContain("Save online text to");
    expect(site.calls.some(call => call.url.endsWith("repository_ajax.php?action=upload") || call.url === `${VIEW}&action=editsubmission` && call.method === "POST")).toBe(false);
    input.destroy();
    stderr.destroy();
  });

  it("replaces saved files with online text through the shared client", async () => {
    const site = fakeSite({ onlineText: true, status: "draft", draft: [{ filename: "old.pdf", size: 5 }] });
    const client = new MoodleClient(BASE, {
      cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 3,
      unavailable: ["core_get_strings"],
      fetchImpl: (input, init) => site.deps.request(String(input), init),
    });

    const receipt = await client.submitAssignment(request({ files: [], text: "<p>Replacement text</p>", replace: true }));

    expect(receipt).toMatchObject({ action: "saved", text: "Replacement text", files: [], removed: ["old.pdf"] });
    expect(site.calls.some(call => call.url.endsWith("draftfiles_ajax.php?action=deleteselected"))).toBe(true);
    expect(site.calls.some(call => call.url.endsWith("repository_ajax.php?action=upload"))).toBe(false);
  });

  it("refuses replacing an existing draft with no files or online text", async () => {
    const site = fakeSite({ status: "draft", draft: [{ filename: "old.pdf", size: 5 }] });
    const client = new MoodleClient(BASE, {
      cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 3,
      unavailable: ["core_get_strings"],
      fetchImpl: (input, init) => site.deps.request(String(input), init),
    });

    await expect(client.submitAssignment(request({ files: [], replace: true, final: true }))).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("would empty") });
    expect(site.calls).toHaveLength(0);
  });

  it("saves a text-only draft before opening final confirmation", async () => {
    const site = fakeSite({ onlineText: true, noFiles: true, needsSavedConfirmation: true });
    const receipt = await submitAssignmentFiles(site.deps, request({ files: [], text: "<p>First</p><p>Second</p>", final: true, acceptStatement: true }));
    expect(receipt.action).toBe("submitted");
    expect(receipt.text).toBe("First\nSecond");
    const save = site.calls.findIndex(call => call.method === "POST" && call.url === `${VIEW}&action=editsubmission`);
    const confirm = site.calls.findIndex(call => call.url === `${VIEW}&action=submit`);
    expect(save).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(save);
    expect(new URLSearchParams(String(site.calls[save].body)).get("onlinetext_editor[text]")).toBe("<p>First</p><p>Second</p>");
    expect(site.calls.some(call => call.url.includes("repository/"))).toBe(false);
  });

  it("removes an editable submission using Moodle's confirmation form and verifies it", async () => {
    const { removeAssignmentSubmission } = await import("../src/moodle-assign-core.js");
    const site = fakeSite({ status: "draft", draft: [{ filename: "essay.pdf", size: 5 }] });
    const plan = await removeAssignmentSubmission(site.deps, 555, true);
    expect(plan.action).toBe("planned");
    expect(site.calls.every(call => call.method === "GET")).toBe(true);
    const receipt = await removeAssignmentSubmission(site.deps, 555);
    expect(receipt).toMatchObject({ action: "removed", id: 555, files: [] });
  });

  it("does not report an empty group submission as submitted", async () => {
    const site = fakeSite({ group: "Team Alpha" });
    await expect(submitAssignmentFiles(site.deps, request({ files: [], final: true }))).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("No saved draft") });
    expect(site.calls.every(call => call.method !== "POST" || call.url.includes("action=list"))).toBe(true);
  });

  it("explains a locked assignment without treating it as missing", async () => {
    const site = fakeSite();
    const send = site.deps.request;
    site.deps.request = async (url, init, options) => {
      if (url.endsWith("action=editsubmission")) throw new MoodleAPIError("Permission denied", "nopermission");
      return send(url, init, options);
    };
    await expect(submitAssignmentFiles(site.deps, request({ final: true }))).rejects.toMatchObject({ code: "upstream", message: expect.stringContaining("locked") });
  });

  it("keeps the current draft separate from submitted attempt history", async () => {
    const site = fakeSite({ status: "draft", draft: [{ filename: "essay.pdf", size: 5 }], history: true });
    const receipt = await submitAssignmentFiles(site.deps, request({}));
    expect(receipt).toMatchObject({ action: "saved", submission_state: "draft" });
    expect(receipt.files.map(file => file.name)).toEqual(["essay.pdf"]);
  });

  it("reads submitted paragraphs from a real Moodle 5 student page", async () => {
    const html = readFileSync(new URL("./fixtures/moodle-5.0/assign-online-text.html", import.meta.url), "utf8");
    const client = new MoodleClient(BASE, { cookie: { name: "MoodleSession", value: "fixture" }, sesskey: "fixture", userid: 3, unavailable: ["core_get_strings"], fetchImpl: async () => page(`${BASE}/mod/assign/view.php?id=73`, html) });
    const detail = await client.getAssignment(73);
    expect(detail).toMatchObject({ name: "Reflection (online text)", submission_state: "submitted", submission: { text: "First paragraph.\nSecond paragraph.", text_html: "<p>First paragraph.</p><p>Second paragraph.</p>", files: [] } });
  });

  it("plans without sending anything that writes", async () => {
    const site = fakeSite();
    const receipt = await submitAssignmentFiles(site.deps, request({ dryRun: true }));

    expect(receipt).toMatchObject({ id: 555, name: "Essay 1", unit_id: 101, url: VIEW, action: "planned", draft_stage: true, submission_status: "No submission", files: [], uploads: [{ name: "essay.pdf", bytes: 5, path: "/work/essay.pdf" }], removed: [], limits: { max_bytes: 1048576, max_files: 2 }, checked_at: "2026-05-13T09:00:00.000Z" });
    expect(site.calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `GET ${VIEW}`,
      `GET ${VIEW}&action=editsubmission`,
      `POST ${BASE}/repository/draftfiles_ajax.php?action=list`,
      `GET ${VIEW}&action=submit`,
    ]);
    expect(intentContracts.submit.output.safeParse({ submission: stripEmpty(receipt) }).success).toBe(true);
  });

  it("uploads into the draft area, replays the form in order and reads the receipt back", async () => {
    const site = fakeSite();
    const receipt = await submitAssignmentFiles(site.deps, request({}));

    expect(receipt).toMatchObject({ action: "saved", draft_stage: true, submission_status: "Draft (not submitted)", last_modified: "Wednesday, 13 May 2026, 9:00 AM", files: [{ name: "essay.pdf", url: `${BASE}/pluginfile.php/9001/assignsubmission_file/submission_files/1/essay.pdf` }] });
    expect(site.calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `GET ${VIEW}`,
      `GET ${VIEW}&action=editsubmission`,
      `POST ${BASE}/repository/draftfiles_ajax.php?action=list`,
      `GET ${VIEW}&action=submit`,
      `POST ${BASE}/repository/repository_ajax.php?action=upload`,
      `POST ${VIEW}&action=editsubmission`,
      `GET ${VIEW}`,
    ]);
    const upload = site.calls[4].body as FormData;
    expect(Object.fromEntries([...upload.entries()].filter(([key]) => key !== "repo_upload_file"))).toEqual({
      sesskey: "fixture-sesskey", client_id: "c1", repo_id: "3", itemid: ITEMID, env: "filemanager", ctx_id: "9001", title: "essay.pdf", author: "Alex", license: "allrightsreserved", savepath: "/", maxbytes: "1048576", areamaxbytes: "-1", "accepted_types[]": "*", overwrite: "1",
    });
    const file = upload.get("repo_upload_file") as File;
    expect(file.name).toBe("essay.pdf");
    expect(await file.text()).toBe("hello");
    expect(site.calls[4].options).toEqual({ allowErrorStatus: true });
    // Ordered replay: the page's own `action=editsubmission` comes first, the form's `savesubmission` last, so PHP keeps the latter.
    expect(site.calls[5].body).toBe(`id=555&action=editsubmission&lastmodified=1715000000&sesskey=fixture-sesskey&_qf__mod_assign_submission_form=1&id=555&userid=7&action=savesubmission&files_filemanager=${ITEMID}&submitbutton=Save+changes`);
    expect(site.calls[5].headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
  });

  it("submits for grading only after the statement was accepted, and verifies the final status", async () => {
    const site = fakeSite();
    await expect(submitAssignmentFiles(site.deps, request({ final: true }))).rejects.toMatchObject({ code: "usage", message: `The draft was saved. Moodle requires you to accept this statement: "${STATEMENT}"`, submission: { action: "saved", draft_stage: true, statement_accepted: false, files: [{ name: "essay.pdf" }] } });
    expect(site.calls.filter(call => call.method === "POST" && String(call.body).includes("confirmsubmit"))).toHaveLength(0);

    site.calls.length = 0;
    const receipt = await submitAssignmentFiles(site.deps, request({ final: true, acceptStatement: true }));
    expect(receipt).toMatchObject({ action: "submitted", submission_status: "Submitted for grading", statement: STATEMENT, statement_accepted: true });
    const confirm = site.calls.find(call => call.method === "POST" && String(call.body).includes("confirmsubmit"));
    expect(confirm?.body).toBe("sesskey=fixture-sesskey&_qf__mod_assign_confirm_submission_form=1&id=555&action=confirmsubmit&submissionstatement=1&submitbutton=Continue");
  });

  it("finalises an existing draft without re-saving when no files are given", async () => {
    // No statement here, so the draft stage is read off the view page's "Submit assignment" button.
    const site = fakeSite({ draft: [{ filename: "old.pdf", size: 10 }], status: "draft", statement: false });
    const receipt = await submitAssignmentFiles(site.deps, { ...request({ final: true }), files: [] });
    expect(receipt.action).toBe("submitted");
    expect(site.calls.map(call => `${call.method} ${call.url}`)).not.toContain(`POST ${VIEW}&action=editsubmission`);
    await expect(submitAssignmentFiles(site.deps, { ...request({}), files: [] })).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses to save without --final when saving would submit for grading", async () => {
    // The statement sits on the edit form only when the assignment has no draft stage.
    const site = fakeSite({ drafts: false });
    const refusal = { code: "usage", message: "This assignment has no draft stage: Moodle submits it for grading as soon as the files are saved.", hint: expect.stringContaining("Nothing was uploaded") };
    await expect(submitAssignmentFiles(site.deps, request({ dryRun: true, acceptStatement: true }))).rejects.toMatchObject(refusal);
    await expect(submitAssignmentFiles(site.deps, request({ acceptStatement: true }))).rejects.toMatchObject(refusal);
    expect(site.calls.filter(call => call.method === "POST" && !call.url.includes("action=list"))).toHaveLength(0);

    const plan = await submitAssignmentFiles(site.deps, request({ final: true, acceptStatement: true, dryRun: true }));
    expect(plan).toMatchObject({ action: "planned", draft_stage: false, statement: STATEMENT });
    expect(formatSubmissionReceipt(plan)).toContain("no; saving submits for grading");

    site.calls.length = 0;
    const receipt = await submitAssignmentFiles(site.deps, request({ final: true, acceptStatement: true }));
    expect(receipt).toMatchObject({ action: "submitted", draft_stage: false, submission_status: "Submitted for grading" });
    // Saving was the submission: one form post, carrying the statement, and no confirmation step.
    const posts = site.calls.filter(call => call.method === "POST" && !call.url.includes("_ajax.php"));
    expect(posts.map(call => call.url)).toEqual([`${VIEW}&action=editsubmission`]);
    expect(String(posts[0].body)).toContain("submissionstatement=1");
    expect(site.calls.map(call => call.url)).not.toContain(`${VIEW}&action=submit`);
  });

  it("reads a missing draft stage off a submitted submission that is still editable", async () => {
    // Moodle locks a submitted submission when there is a draft stage.
    const site = fakeSite({ drafts: false, statement: false, status: "submitted", draft: [{ filename: "old.pdf", size: 10 }] });
    await expect(submitAssignmentFiles(site.deps, request({ replace: true }))).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("no draft stage") });
    expect(site.calls.filter(call => call.method === "POST" && !call.url.includes("action=list"))).toHaveLength(0);
  });

  it("treats a draft stage Moodle's pages do not show as saving that submits", async () => {
    // Without a statement or an existing draft, no student-facing page shows the setting.
    const site = fakeSite({ statement: false });
    await expect(submitAssignmentFiles(site.deps, request({}))).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("does not show whether this assignment keeps drafts") });
    expect(site.calls.filter(call => call.method === "POST" && !call.url.includes("action=list"))).toHaveLength(0);

    const receipt = await submitAssignmentFiles(site.deps, request({ final: true }));
    expect(receipt).toMatchObject({ action: "submitted", submission_status: "Submitted for grading" });
    expect(receipt).not.toHaveProperty("draft_stage");
  });

  it("fails loudly when Moodle submits on a save that should have been a draft", async () => {
    const site = fakeSite({ saveSubmits: true });
    await expect(submitAssignmentFiles(site.deps, request({}))).rejects.toMatchObject({ code: "upstream", message: expect.stringContaining("Moodle submitted the assignment for grading when the files were saved") });
  });

  it("replaces existing files on request and otherwise enforces the file limit", async () => {
    const site = fakeSite({ draft: [{ filename: "old.pdf", size: 10 }, { filename: "notes.txt", size: 3 }], maxfiles: 2 });
    await expect(submitAssignmentFiles(site.deps, request({}))).rejects.toMatchObject({ code: "usage", message: "This assignment allows 2 files; the submission would hold 3.", hint: "Use --replace to drop the existing files first." });

    site.calls.length = 0;
    const receipt = await submitAssignmentFiles(site.deps, request({ replace: true }));
    expect(receipt.removed).toEqual(["old.pdf", "notes.txt"]);
    const remove = site.calls.find(call => call.url.includes("action=deleteselected"));
    expect(new URLSearchParams(String(remove?.body)).get("selected")).toBe(JSON.stringify([{ filename: "old.pdf", filepath: "/" }, { filename: "notes.txt", filepath: "/" }]));
  });

  it("refuses --replace with no files instead of emptying the submission", async () => {
    const site = fakeSite({ draft: [{ filename: "old.pdf", size: 10 }], status: "draft", statement: false });
    await expect(submitAssignmentFiles(site.deps, request({ files: [], replace: true, final: true }))).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("would empty the submission") });
    expect(site.calls).toHaveLength(0);
  });

  it("names the group whose shared files a group submission changes", async () => {
    const site = fakeSite({ group: "Team 7", draft: [{ filename: "theirs.pdf", size: 10 }], status: "draft" });
    const receipt = await submitAssignmentFiles(site.deps, request({ dryRun: true, replace: true }));
    expect(receipt).toMatchObject({ group: "Team 7", removed: ["theirs.pdf"] });
    expect(formatSubmissionReceipt(receipt)).toContain("the files are shared, so this changes the submission for everyone in Team 7");
  });

  it("reports a submitted part when the group still waits for other members", async () => {
    const site = fakeSite({ group: "Team 7", waitsFor: ["Student B"], draft: [{ filename: "essay.pdf", size: 5 }], status: "draft", statement: false });
    const receipt = await submitAssignmentFiles(site.deps, request({ files: [], final: true, acceptStatement: true }));
    expect(receipt).toMatchObject({ action: "submitted", group: "Team 7", awaiting: ["Student B"], submission_status: "Draft (not submitted)" });
    expect(formatSubmissionReceipt(receipt)).toContain("Your part is submitted");
  });

  it("rejects oversized or wrong-type files before touching the site", async () => {
    const site = fakeSite({ maxbytes: 3, accepted: [".pdf", ".docx"] });
    await expect(submitAssignmentFiles(site.deps, request({}))).rejects.toMatchObject({ code: "usage", message: "essay.pdf is 5 B; the limit is 3 B." });
    const typed = fakeSite({ accepted: [".docx"] });
    await expect(submitAssignmentFiles(typed.deps, request({}))).rejects.toMatchObject({ code: "usage", message: "essay.pdf is not an accepted type; allowed: .docx." });
    expect([...site.calls, ...typed.calls].filter(call => call.url.includes("upload"))).toHaveLength(0);
  });

  it("treats an empty accepted-types list as any type, as Moodle does when none are configured", async () => {
    // Moodle 4.5 renders `"accepted_types":[]` for an assignment with no file type restriction.
    const site = fakeSite({ accepted: [] });
    const receipt = await submitAssignmentFiles(site.deps, request({}));
    expect(receipt.limits.accepted_types).toBeUndefined();
    const upload = site.calls.find(call => call.url.includes("action=upload"));
    expect((upload?.body as FormData).getAll("accepted_types[]")).toEqual(["*"]);
  });

  it("reads accepted types that PHP serialised as an object", () => {
    // A PHP array with gaps in its keys becomes a JSON object, not a list.
    const html = editPage({ accepted: { "0": ".pdf", "2": ".docx" } });
    expect(parseSubmissionForm(html, { baseUrl: BASE, fail: message => new MoodleAPIError(message) }).acceptedTypes).toEqual([".pdf", ".docx"]);
  });

  it("restores the lists the intent layer strips from a first-time plan", async () => {
    // A first submission has no files and removes nothing, so stripEmpty drops both lists.
    const site = fakeSite({ accepted: [] });
    const stripped = stripEmpty({ submission: await submitAssignmentFiles(site.deps, request({ dryRun: true })) }) as { submission: unknown };
    expect(stripped.submission).not.toHaveProperty("removed");
    const receipt = submissionReceiptOf(stripped.submission);
    expect(receipt).toMatchObject({ files: [], removed: [], uploads: [{ name: "essay.pdf" }], limits: { max_files: 2 } });
    expect(formatSubmissionReceipt(receipt)).toContain("Submission plan");
    expect(submissionReceiptOf({ id: 555, name: "Essay 1", action: "saved" })).toMatchObject({ files: [], uploads: [], removed: [], limits: {} });
  });

  it("surfaces Moodle's own refusals", async () => {
    const closed = fakeSite({ closed: true });
    await expect(submitAssignmentFiles(closed.deps, request({}))).rejects.toMatchObject({ code: "upstream", message: "Moodle is not accepting a submission: Submissions closed" });

    const refusedUpload = fakeSite({ uploadError: "File is larger than the site limit" });
    await expect(submitAssignmentFiles(refusedUpload.deps, request({}))).rejects.toMatchObject({ code: "upstream", message: "Moodle refused essay.pdf: File is larger than the site limit" });

    const rejectedSave = fakeSite({ saveNotice: "You have existing submission data. Please leave this page and try again." });
    await expect(submitAssignmentFiles(rejectedSave.deps, request({}))).rejects.toMatchObject({ code: "upstream", message: "Moodle did not save the submission: You have existing submission data. Please leave this page and try again." });

    const forgetful = fakeSite({ forgetUploads: true });
    await expect(submitAssignmentFiles(forgetful.deps, request({}))).rejects.toMatchObject({ code: "upstream", message: expect.stringContaining("does not list essay.pdf") });
  });

  it("reads the filemanager options that belong to the submission field", () => {
    const html = editPage({ statement: true }).replace("<script>", `<script>M.form_filemanager.init(Y, {"itemid":1,"maxfiles":1,"client_id":"other","filepicker":{"repositories":[]}});</script><script>`);
    const form = parseSubmissionForm(html, { baseUrl: BASE, fail: message => new MoodleAPIError(message) });
    expect(form).toMatchObject({ itemid: ITEMID, clientId: "c1", contextId: "9001", repoId: "3", maxFiles: 2, maxBytes: 1048576, areaMaxBytes: -1, acceptedTypes: "*", statement: STATEMENT });
    expect(form.fields.filter(([name]) => name === "action").map(([, value]) => value)).toEqual(["editsubmission", "savesubmission"]);
    expect(form.fields.some(([name]) => name === "submissionstatement")).toBe(false);
    expect(() => parseSubmissionForm(editPage().replace(/name="files_filemanager"/u, 'name="other"'), { baseUrl: BASE, fail: message => new MoodleAPIError(message) })).toThrow("accepts neither file uploads nor online text");
  });
});

describe("local submission files", () => {
  it("keeps plain-text paragraphs and HTML when reading online submissions", async () => {
    const { readSubmissionText } = await import("../src/submit.js");
    const directory = await mkdtemp(join(tmpdir(), "moodle-submit-text-"));
    await writeFile(join(directory, "reflection.md"), "First paragraph.\n\nSecond & last.");
    await writeFile(join(directory, "reflection.html"), "<p>First</p><p>Second</p>");
    expect(await readSubmissionText({ text: "First paragraph.\n\nSecond & last." })).toBe("<p>First paragraph.</p>\n<p>Second &amp; last.</p>");
    expect(await readSubmissionText({ textFile: "reflection.md", cwd: directory })).toBe("<p>First paragraph.</p>\n<p>Second &amp; last.</p>");
    expect(await readSubmissionText({ textFile: "reflection.html", cwd: directory })).toBe("<p>First</p><p>Second</p>");
    await expect(readSubmissionText({ text: "one", textFile: "reflection.md", cwd: directory })).rejects.toMatchObject({ code: "usage" });
  });

  it("reads files by path and refuses folders or missing paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-submit-"));
    await writeFile(join(directory, "essay.pdf"), "hello");
    const [file] = await readSubmissionFiles(["essay.pdf"], directory);
    expect(file).toMatchObject({ name: "essay.pdf", path: join(directory, "essay.pdf") });
    expect(Buffer.from(file.bytes).toString()).toBe("hello");
    await expect(readSubmissionFiles(["missing.pdf"], directory)).rejects.toMatchObject({ code: "usage", message: "File not found: missing.pdf" });
    await expect(readSubmissionFiles(["."], directory)).rejects.toMatchObject({ code: "usage", message: "Not a file: ." });
  });
});

function request(overrides: Partial<SubmitAssignmentRequest>): SubmitAssignmentRequest {
  return { activityId: 555, files: [{ name: "essay.pdf", bytes: new TextEncoder().encode("hello"), path: "/work/essay.pdf" }], ...overrides };
}

interface Call { method: string; url: string; body?: BodyInit | null; headers?: Record<string, string>; options?: { allowErrorStatus?: boolean } }

interface SiteOptions {
  history?: boolean;
  onlineText?: boolean;
  noFiles?: boolean;
  needsSavedConfirmation?: boolean;
  draft?: Array<{ filename: string; size: number }>;
  status?: "none" | "draft" | "submitted";
  /** The assignment's "require students to click the submit button"; on unless false. */
  drafts?: boolean;
  /** The site requires a submission statement; on unless false. */
  statement?: boolean;
  /** Moodle submits on save despite rendering a draft stage. */
  saveSubmits?: boolean;
  maxfiles?: number;
  maxbytes?: number;
  accepted?: unknown;
  closed?: boolean;
  uploadError?: string;
  saveNotice?: string;
  forgetUploads?: boolean;
  /** A group submission for this group. */
  group?: string;
  /** Other members Moodle waits for: every member has to submit, so the group stays a draft until they do. */
  waitsFor?: string[];
}

// A tiny stateful Moodle: the draft area, the saved files and the status move only when the right POST arrives.
// It renders the draft-stage setting the way Moodle does: the statement sits on the edit form only
// without a draft stage, "Submit assignment" appears only with one, and saving without one submits.
function fakeSite(options: SiteOptions = {}) {
  const calls: Call[] = [];
  const drafts = options.drafts !== false;
  const statement = options.statement !== false;
  let draft = [...(options.draft ?? [])];
  let saved = options.status && options.status !== "none" ? [...draft] : [];
  let status = options.status ?? "none";
  let savedText = "";
  let awaiting = options.waitsFor ? ["Student A", ...options.waitsFor] : [];
  const view = () => viewPage(status, saved, drafts, options.group, awaiting)
    .replace('<table class="generaltable">', '<div class="submissionstatustable"><table class="generaltable">')
    .replace("</table>", `</table>${savedText ? `<div class="plugincontentsummary summary_assignsubmission_onlinetext_7"><div class="no-overflow">${savedText}</div></div>` : ""}</div>`)
    .replace("</body>", options.history ? '<div class="attempthistory"><div class="submissionstatussubmitted">Submitted</div><div class="fileuploadsubmission"><a href="/pluginfile.php/old.txt">old.txt</a></div></div></body>' : "</body>");
  const deps: AssignSubmitDeps = {
    baseUrl: BASE,
    now: () => new Date("2026-05-13T09:00:00Z"),
    fail: (message, code) => new MoodleAPIError(message, code),
    usage: (message, hint) => new UsageError(message, hint),
    async request(url, init = {}, requestOptions) {
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init.body, headers: init.headers as Record<string, string> | undefined, options: requestOptions });
      if (url === VIEW && method === "GET") return page(url, view());
      if (url === `${VIEW}&action=removesubmissionconfirm`) return page(url, `<form action="${VIEW}" method="post"><input name="id" value="555"><input name="action" value="removesubmission"><input name="sesskey" value="fixture-sesskey"></form>`);
      if (url === VIEW && method === "POST") { saved = []; savedText = ""; status = "none"; return page(VIEW, view()); }

      if (url === `${VIEW}&action=editsubmission` && method === "GET") return page(url, options.closed || (drafts && status === "submitted") ? closedPage() : editPage({ statement: statement && !drafts, maxfiles: options.maxfiles, maxbytes: options.maxbytes, accepted: options.accepted, onlineText: options.onlineText, noFiles: options.noFiles }));
      if (url === `${VIEW}&action=submit` && method === "GET") return page(url, options.needsSavedConfirmation && status === "none" ? closedPage() : confirmPage(statement));
      if (url.endsWith("draftfiles_ajax.php?action=list")) return json(url, { list: draft.map(file => ({ ...file, filepath: "/", fullname: file.filename, type: "file" })), filecount: draft.length });
      if (url.endsWith("draftfiles_ajax.php?action=deleteselected")) { draft = []; return json(url, ["/"]); }
      if (url.endsWith("repository_ajax.php?action=upload")) {
        if (options.uploadError) return json(url, { error: options.uploadError });
        const file = (init.body as FormData).get("repo_upload_file") as File;
        draft = [...draft.filter(item => item.filename !== file.name), { filename: file.name, size: file.size }];
        return json(url, { url: `${BASE}/draftfile.php/5/user/draft/${ITEMID}/${file.name}`, id: ITEMID, file: file.name });
      }
      if (url === `${VIEW}&action=editsubmission` && method === "POST") {
        if (options.saveNotice) return page(url, editPage({ notice: options.saveNotice }));
        savedText = new URLSearchParams(String(init.body)).get("onlinetext_editor[text]") ?? savedText;
        saved = options.forgetUploads ? [] : [...draft];
        status = drafts && !options.saveSubmits ? "draft" : "submitted";
        return page(`${VIEW}&action=view`, view());
      }
      if (url === `${VIEW}&action=submit` && method === "POST") {
        awaiting = options.waitsFor ?? [];
        status = awaiting.length ? "draft" : "submitted";
        return page(`${VIEW}&action=view`, view());
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    },
  };
  return { deps, calls };
}

function page(url: string, html: string): Response {
  const response = new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function json(url: string, body: unknown): Response {
  const response = new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function viewPage(status: "none" | "draft" | "submitted", files: Array<{ filename: string }>, drafts = true, group?: string, awaiting: string[] = []): string {
  const label = status === "none" ? (group ? "Nothing has been submitted for this assignment" : "No submission") : status === "draft" ? "Draft (not submitted)" : "Submitted for grading";
  const rows = files.map(file => `<div class="fileuploadsubmission"><a href="/pluginfile.php/9001/assignsubmission_file/submission_files/1/${file.filename}" target="_blank">${file.filename}</a></div>`).join("");
  return `<!doctype html><html><body>
<nav aria-label="Breadcrumb"><a href="${BASE}/course/view.php?id=101">Mathematics 101</a></nav>
<h1>Essay 1</h1>
${drafts && status === "draft" && files.length ? `<div class="singlebutton"><form method="get" action="${BASE}/mod/assign/view.php"><input type="hidden" name="id" value="555"><input type="hidden" name="action" value="submit"><button type="submit" class="btn btn-primary">Submit assignment</button></form></div>` : ""}
<p><strong>Due:</strong> Friday, 15 May 2026, 5:00 PM</p>
<table class="generaltable">
${group ? `<tr><th>Group</th><td>${group}</td></tr>` : ""}
<tr><th>Submission status</th><td class="${status === "none" ? "" : `submissionstatus${status}`}">${label}${awaiting.length && status !== "none" ? `<div class="box py-3">Users who need to submit: ${awaiting.map(name => `<a href="${BASE}/user/view.php?id=1">${name}</a>`).join(", ")}</div>` : ""}</td></tr>
<tr><th>Grading status</th><td>Not graded</td></tr>
<tr><th>Time remaining</th><td>2 days</td></tr>
${status === "none" ? "" : "<tr><th>Last modified</th><td>Wednesday, 13 May 2026, 9:00 AM</td></tr>"}
${files.length ? `<tr><th>File submissions</th><td>${rows}</td></tr>` : ""}
</table>
</body></html>`;
}

function editPage(options: { statement?: boolean; maxfiles?: number; maxbytes?: number; accepted?: unknown; notice?: string; onlineText?: boolean; noFiles?: boolean } = {}): string {
  const statement = options.statement
    ? `<div class="form-check"><input type="checkbox" name="submissionstatement" id="id_submissionstatement" value="1" class="form-check-input"><label class="form-check-label" for="id_submissionstatement">${STATEMENT}</label></div>`
    : "";
  const filemanager = {
    client_id: "c1", itemid: Number(ITEMID), target: "id_files_filemanager", maxbytes: options.maxbytes ?? 1048576, areamaxbytes: -1, maxfiles: options.maxfiles ?? 2, accepted_types: options.accepted ?? "*", context: { id: 9001 },
    filepicker: { author: "Alex", defaultlicense: "allrightsreserved", repositories: { "3": { id: 3, name: "Upload a file", type: "upload" }, "5": { id: 5, name: "Private files", type: "user" } } },
  };
  return `<!doctype html><html><body>
${options.notice ? `<div class="alert alert-danger" role="alert">${options.notice}</div>` : ""}
<h1>Essay 1</h1>
<form autocomplete="off" action="${VIEW}&amp;action=editsubmission" method="post" id="mform1" class="mform">
<input name="id" type="hidden" value="555">
<input name="action" type="hidden" value="editsubmission">
<input name="lastmodified" type="hidden" value="1715000000">
<input name="sesskey" type="hidden" value="fixture-sesskey">
<input name="_qf__mod_assign_submission_form" type="hidden" value="1">
<input name="id" type="hidden" value="555">
<input name="userid" type="hidden" value="7">
<input name="action" type="hidden" value="savesubmission">
${options.noFiles ? "" : `<input value="${ITEMID}" name="files_filemanager" type="hidden" id="id_files_filemanager">`}
${options.onlineText ? `<textarea name="onlinetext_editor[text]"></textarea><input name="onlinetext_editor[format]" value="1" type="hidden">` : ""}
${statement}
<input type="submit" name="submitbutton" value="Save changes"><input type="submit" name="cancel" value="Cancel">
</form>
<script>M.util.js_pending('core/first'); Y.use('form_filemanager', function(Y) { M.form_filemanager.init(Y, ${JSON.stringify(filemanager)}); M.util.js_complete('core/first'); });</script>
</body></html>`;
}

function confirmPage(statement: boolean): string {
  return `<!doctype html><html><body><h1>Essay 1</h1>
<form action="${VIEW}&amp;action=submit" method="post" class="mform">
<input name="sesskey" type="hidden" value="fixture-sesskey">
<input name="_qf__mod_assign_confirm_submission_form" type="hidden" value="1">
${statement ? `<div class="form-check"><input type="checkbox" name="submissionstatement" id="id_submissionstatement" value="1"><label for="id_submissionstatement">${STATEMENT}</label></div>` : ""}
<div class="form-control-static">Are you sure you want to submit your work for grading? You will not be able to make any more changes.</div>
<input name="id" type="hidden" value="555">
<input name="action" type="hidden" value="confirmsubmit">
<input type="submit" name="submitbutton" value="Continue"><input type="submit" name="cancel" value="Cancel">
</form></body></html>`;
}

function closedPage(): string {
  return `<!doctype html><html><body><h1>Essay 1</h1><div class="alert alert-info" role="alert">Submissions closed</div></body></html>`;
}
