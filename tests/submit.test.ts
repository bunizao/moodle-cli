import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
  it("plans without sending anything that writes", async () => {
    const site = fakeSite();
    const receipt = await submitAssignmentFiles(site.deps, request({ dryRun: true }));

    expect(receipt).toMatchObject({ id: 555, name: "Essay 1", unit_id: 101, url: VIEW, action: "planned", submission_status: "No submission", files: [], uploads: [{ name: "essay.pdf", bytes: 5, path: "/work/essay.pdf" }], removed: [], limits: { max_bytes: 1048576, max_files: 2 }, checked_at: "2026-05-13T09:00:00.000Z" });
    expect(site.calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `GET ${VIEW}`,
      `GET ${VIEW}&action=editsubmission`,
      `POST ${BASE}/repository/draftfiles_ajax.php?action=list`,
    ]);
    expect(intentContracts.submit.output.safeParse({ submission: stripEmpty(receipt) }).success).toBe(true);
  });

  it("uploads into the draft area, replays the form in order and reads the receipt back", async () => {
    const site = fakeSite();
    const receipt = await submitAssignmentFiles(site.deps, request({}));

    expect(receipt).toMatchObject({ action: "saved", submission_status: "Draft (not submitted)", last_modified: "Wednesday, 13 May 2026, 9:00 AM", files: [{ name: "essay.pdf", url: `${BASE}/pluginfile.php/9001/assignsubmission_file/submission_files/1/essay.pdf` }] });
    expect(site.calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `GET ${VIEW}`,
      `GET ${VIEW}&action=editsubmission`,
      `POST ${BASE}/repository/draftfiles_ajax.php?action=list`,
      `POST ${BASE}/repository/repository_ajax.php?action=upload`,
      `POST ${VIEW}&action=editsubmission`,
      `GET ${VIEW}`,
    ]);
    const upload = site.calls[3].body as FormData;
    expect(Object.fromEntries([...upload.entries()].filter(([key]) => key !== "repo_upload_file"))).toEqual({
      sesskey: "fixture-sesskey", client_id: "c1", repo_id: "3", itemid: ITEMID, env: "filemanager", ctx_id: "9001", title: "essay.pdf", author: "Alex", license: "allrightsreserved", savepath: "/", maxbytes: "1048576", areamaxbytes: "-1", "accepted_types[]": "*", overwrite: "1",
    });
    const file = upload.get("repo_upload_file") as File;
    expect(file.name).toBe("essay.pdf");
    expect(await file.text()).toBe("hello");
    expect(site.calls[3].options).toEqual({ allowErrorStatus: true });
    // Ordered replay: the page's own `action=editsubmission` comes first, the form's `savesubmission` last, so PHP keeps the latter.
    expect(site.calls[4].body).toBe(`id=555&action=editsubmission&lastmodified=1715000000&sesskey=fixture-sesskey&_qf__mod_assign_submission_form=1&id=555&userid=7&action=savesubmission&files_filemanager=${ITEMID}&submitbutton=Save+changes`);
    expect(site.calls[4].headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
  });

  it("submits for grading only after the statement was accepted, and verifies the final status", async () => {
    const site = fakeSite({ confirmStatement: true });
    await expect(submitAssignmentFiles(site.deps, request({ final: true }))).rejects.toMatchObject({ code: "usage", message: `Moodle requires you to accept this statement: "${STATEMENT}"` });
    expect(site.calls.filter(call => call.method === "POST" && !call.url.includes("action=list"))).toHaveLength(0);

    site.calls.length = 0;
    const receipt = await submitAssignmentFiles(site.deps, request({ final: true, acceptStatement: true }));
    expect(receipt).toMatchObject({ action: "submitted", submission_status: "Submitted for grading", statement: STATEMENT, statement_accepted: true });
    const confirm = site.calls.find(call => call.method === "POST" && String(call.body).includes("confirmsubmit"));
    expect(confirm?.body).toBe("sesskey=fixture-sesskey&_qf__mod_assign_confirm_submission_form=1&id=555&action=confirmsubmit&submissionstatement=1&submitbutton=Continue");
  });

  it("finalises an existing draft without re-saving when no files are given", async () => {
    const site = fakeSite({ draft: [{ filename: "old.pdf", size: 10 }], status: "draft" });
    const receipt = await submitAssignmentFiles(site.deps, { ...request({ final: true }), files: [] });
    expect(receipt.action).toBe("submitted");
    expect(site.calls.map(call => `${call.method} ${call.url}`)).not.toContain(`POST ${VIEW}&action=editsubmission`);
    await expect(submitAssignmentFiles(site.deps, { ...request({}), files: [] })).rejects.toBeInstanceOf(UsageError);
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
    expect(() => parseSubmissionForm(editPage().replace(/name="files_filemanager"/u, 'name="other"'), { baseUrl: BASE, fail: message => new MoodleAPIError(message) })).toThrow("does not accept file uploads");
  });
});

describe("local submission files", () => {
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
  draft?: Array<{ filename: string; size: number }>;
  status?: "none" | "draft" | "submitted";
  maxfiles?: number;
  maxbytes?: number;
  accepted?: unknown;
  closed?: boolean;
  confirmStatement?: boolean;
  uploadError?: string;
  saveNotice?: string;
  forgetUploads?: boolean;
}

// A tiny stateful Moodle: the draft area, the saved files and the status move only when the right POST arrives.
function fakeSite(options: SiteOptions = {}) {
  const calls: Call[] = [];
  let draft = [...(options.draft ?? [])];
  let saved = options.status && options.status !== "none" ? [...draft] : [];
  let status = options.status ?? "none";
  const deps: AssignSubmitDeps = {
    baseUrl: BASE,
    now: () => new Date("2026-05-13T09:00:00Z"),
    fail: (message, code) => new MoodleAPIError(message, code),
    usage: (message, hint) => new UsageError(message, hint),
    async request(url, init = {}, requestOptions) {
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init.body, headers: init.headers as Record<string, string> | undefined, options: requestOptions });
      if (url === VIEW) return page(url, viewPage(status, saved));
      if (url === `${VIEW}&action=editsubmission` && method === "GET") return page(url, options.closed ? closedPage() : editPage({ maxfiles: options.maxfiles, maxbytes: options.maxbytes, accepted: options.accepted }));
      if (url === `${VIEW}&action=submit` && method === "GET") return page(url, confirmPage(Boolean(options.confirmStatement)));
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
        saved = options.forgetUploads ? [] : [...draft];
        status = "draft";
        return page(`${VIEW}&action=view`, viewPage(status, saved));
      }
      if (url === `${VIEW}&action=submit` && method === "POST") {
        status = "submitted";
        return page(`${VIEW}&action=view`, viewPage(status, saved));
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

function viewPage(status: "none" | "draft" | "submitted", files: Array<{ filename: string }>): string {
  const label = status === "none" ? "No submission" : status === "draft" ? "Draft (not submitted)" : "Submitted for grading";
  const rows = files.map(file => `<div class="fileuploadsubmission"><a href="/pluginfile.php/9001/assignsubmission_file/submission_files/1/${file.filename}" target="_blank">${file.filename}</a></div>`).join("");
  return `<!doctype html><html><body>
<nav aria-label="Breadcrumb"><a href="${BASE}/course/view.php?id=101">Mathematics 101</a></nav>
<h1>Essay 1</h1>
<p><strong>Due:</strong> Friday, 15 May 2026, 5:00 PM</p>
<table class="generaltable">
<tr><th>Submission status</th><td>${label}</td></tr>
<tr><th>Grading status</th><td>Not graded</td></tr>
<tr><th>Time remaining</th><td>2 days</td></tr>
${status === "none" ? "" : "<tr><th>Last modified</th><td>Wednesday, 13 May 2026, 9:00 AM</td></tr>"}
${files.length ? `<tr><th>File submissions</th><td>${rows}</td></tr>` : ""}
</table>
</body></html>`;
}

function editPage(options: { statement?: boolean; maxfiles?: number; maxbytes?: number; accepted?: unknown; notice?: string } = {}): string {
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
<input value="${ITEMID}" name="files_filemanager" type="hidden" id="id_files_filemanager">
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
