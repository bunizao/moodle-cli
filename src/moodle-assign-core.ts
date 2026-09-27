import { parse, type HTMLElement } from "node-html-parser";

import { ASSIGN_VIEW_PATH } from "./constants.js";
import { cleanText, resolveUrl } from "./html-utils.js";
import { parseAssignmentHtml } from "./scraper.js";

// Assignment submission replays the browser flow, because the site-restricted AJAX
// services this CLI can reach have no upload call. The sequence mirrors what a
// browser does: load the edit form, upload into the form's draft area, post the
// form back, then (optionally) confirm "submit for grading". Every step is verified
// against the page Moodle renders afterwards; the receipt is read from that page,
// never assumed from the request having been sent.

export interface SubmitFile {
  name: string;
  bytes: Uint8Array;
  path?: string;
}

export interface SubmitAssignmentRequest {
  activityId: number;
  files: SubmitFile[];
  /** Also submit for grading after saving. Moodle treats that as irreversible. */
  final?: boolean;
  /** Remove every file already in the submission before uploading. */
  replace?: boolean;
  /** Tick the site's submission statement when Moodle requires one. */
  acceptStatement?: boolean;
  /** Load and validate everything, but send nothing that changes state. */
  dryRun?: boolean;
  /** Each slow step, in words a person can watch: which file is uploading, when the form is saved. */
  onProgress?: (message: string) => void;
}

export interface SubmissionFileRow {
  name: string;
  bytes?: number;
  url?: string;
}

export interface SubmissionLimits {
  max_bytes?: number;
  max_files?: number;
  area_max_bytes?: number;
  accepted_types?: string[];
}

export interface SubmissionReceipt {
  id: number;
  name: string;
  unit_id?: number;
  url: string;
  action: "planned" | "saved" | "submitted";
  /** False when saving submits for grading at once; absent when Moodle's pages do not show it. */
  draft_stage?: boolean;
  /** The group sharing this submission; absent when it is an individual one. */
  group?: string;
  /** Group members Moodle still waits for before the group's submission counts as submitted. */
  awaiting?: string[];
  submission_status: string;
  grading_status: string;
  due: string;
  time_remaining: string;
  last_modified: string;
  statement?: string;
  statement_accepted?: boolean;
  /** Files Moodle lists in the submission (draft area for a plan, view page after a write). */
  files: SubmissionFileRow[];
  uploads: Array<{ name: string; bytes: number; path?: string }>;
  removed: string[];
  limits: SubmissionLimits;
  checked_at: string;
}

export interface AssignSubmitDeps {
  baseUrl: string;
  request(url: string, init?: RequestInit, options?: { allowErrorStatus?: boolean }): Promise<Response>;
  /** Moodle refused or mangled a step; message is shown to the user as-is. */
  fail(message: string, moodleErrorCode?: string): Error;
  /** The request cannot succeed as given; the caller can change it. */
  usage(message: string, hint?: string): Error;
  now?: () => Date;
}

type Field = [string, string];

export interface SubmissionForm {
  action: string;
  fields: Field[];
  sesskey: string;
  itemid: string;
  clientId: string;
  contextId: string;
  repoId: string;
  author: string;
  license: string;
  maxBytes: number;
  areaMaxBytes: number;
  maxFiles: number;
  acceptedTypes: string[] | "*";
  statement?: string;
}

export interface ConfirmForm {
  action: string;
  fields: Field[];
  statement?: string;
}

interface DraftFile {
  name: string;
  path: string;
  bytes: number;
}

export async function submitAssignmentFiles(deps: AssignSubmitDeps, request: SubmitAssignmentRequest): Promise<SubmissionReceipt> {
  const id = request.activityId;
  if (!Number.isSafeInteger(id) || id <= 0) throw deps.usage("The assignment id must be a positive integer.");
  if (!request.files.length && !request.final) throw deps.usage("Give at least one file to upload, or use --final to submit the existing draft.");
  if (!request.files.length && request.replace) throw deps.usage("--replace with no files would empty the submission.", "Give the files that should replace the current ones.");
  const seen = new Set<string>();
  for (const file of request.files) {
    if (!file.name || /[\\/]/u.test(file.name)) throw deps.usage(`'${file.name}' is not a plain file name.`);
    if (seen.has(file.name.toLowerCase())) throw deps.usage(`'${file.name}' is given twice; Moodle keeps one file per name.`);
    seen.add(file.name.toLowerCase());
  }

  const viewUrl = `${deps.baseUrl}${ASSIGN_VIEW_PATH}?id=${id}`;
  request.onProgress?.("Reading the assignment");
  const viewHtml = await pageText(deps, viewUrl);
  const before = parseReceiptPage(viewHtml, id, deps.baseUrl);
  const form = parseSubmissionForm(await pageText(deps, `${viewUrl}&action=editsubmission`), deps);
  const draft = await listDraftFiles(deps, form);

  const removed = request.replace ? draft.map(file => file.name) : [];
  const kept = request.replace ? [] : draft.filter(file => !seen.has(file.name.toLowerCase()));
  checkLimits(deps, form, kept, request.files);

  // Saving is only a draft when the assignment has a draft stage; otherwise Moodle submits
  // for grading on save. That must be known before anything is written, and an unknown
  // answer counts as "it submits", because a submission for grading cannot be taken back.
  const confirmHtml = form.statement ? undefined : await pageText(deps, `${viewUrl}&action=submit`);
  const draftStage = draftStageOf(viewHtml, before.submission_status, form, confirmHtml);
  if (draftStage !== true && !request.final) {
    throw deps.usage(
      draftStage === false
        ? "This assignment has no draft stage: Moodle submits it for grading as soon as the files are saved."
        : "Moodle does not show whether this assignment keeps drafts, so saving the files may submit it for grading at once.",
      "Nothing was uploaded. Re-run with --final only if you want it submitted for grading now; to keep working, upload later.",
    );
  }

  let statement = form.statement;
  let confirm: ConfirmForm | undefined;
  if (request.final && draftStage !== false && confirmHtml !== undefined) {
    confirm = parseConfirmForm(confirmHtml, deps);
    statement = confirm.statement;
  }
  if (statement && !request.acceptStatement) {
    throw deps.usage(`Moodle requires you to accept this statement: "${statement}"`, "Re-run with --accept-statement once you agree.");
  }

  const limits = describeLimits(form);
  const uploads = request.files.map(file => ({ name: file.name, bytes: file.bytes.byteLength, ...(file.path ? { path: file.path } : {}) }));
  if (request.dryRun) {
    return {
      ...before,
      action: "planned",
      ...(draftStage === undefined ? {} : { draft_stage: draftStage }),
      files: draft.map(file => ({ name: file.name, bytes: file.bytes })),
      uploads,
      removed,
      limits,
      ...(statement ? { statement, statement_accepted: true } : {}),
      checked_at: timestamp(deps),
    };
  }

  // With nothing to upload or remove, --final only confirms the draft that is already there.
  // Without a draft stage, saving below is itself the submission for grading.
  if (removed.length) {
    request.onProgress?.(`Removing ${removed.join(", ")}`);
    await deleteDraftFiles(deps, form, draft);
  }
  const storedNames: string[] = [];
  for (const [index, file] of request.files.entries()) {
    request.onProgress?.(`Uploading ${file.name} (${index + 1}/${request.files.length})`);
    storedNames.push(await uploadDraftFile(deps, form, file));
  }
  if (storedNames.length || removed.length) {
    request.onProgress?.("Saving the submission");
    const savedHtml = await postForm(deps, form.action, [...form.fields, ...(form.statement ? [["submissionstatement", "1"] as Field] : []), ["submitbutton", "Save changes"]]);
    if (savedHtml !== null) throw deps.fail(`Moodle did not save the submission: ${noticesOf(savedHtml) || "it returned the edit form again without a reason"}`);
  }

  request.onProgress?.("Reading the receipt");
  let receipt = parseReceiptPage(await pageText(deps, viewUrl), id, deps.baseUrl);
  const listed = new Set(receipt.files.map(file => file.name.toLowerCase()));
  const missing = storedNames.filter(name => !listed.has(name.toLowerCase()));
  if (missing.length) throw deps.fail(`Moodle saved the submission but its page does not list ${missing.join(", ")}; check the assignment in a browser before submitting.`);

  let action: SubmissionReceipt["action"] = "saved";
  if (isSubmitted(receipt.submission_status) && !request.final) {
    throw deps.fail(`Moodle submitted the assignment for grading when the files were saved, although its pages showed a draft stage. It now reports "${receipt.submission_status}"; check it in a browser.`);
  }
  if (isSubmitted(receipt.submission_status)) action = "submitted";
  else if (request.final) {
    request.onProgress?.("Submitting for grading");
    confirm ??= parseConfirmForm(await pageText(deps, `${viewUrl}&action=submit`), deps);
    const errorHtml = await postForm(deps, confirm.action, [...confirm.fields, ...(confirm.statement ? [["submissionstatement", "1"] as Field] : []), ["submitbutton", "Continue"]]);
    if (errorHtml !== null) throw deps.fail(`Moodle did not submit the assignment for grading: ${noticesOf(errorHtml) || "it returned the confirmation page again without a reason"}`);
    receipt = parseReceiptPage(await pageText(deps, viewUrl), id, deps.baseUrl);
    // When every member has to submit, the group's status stays a draft until the last one does.
    if (!isSubmitted(receipt.submission_status) && !receipt.awaiting?.length) throw deps.fail(`Moodle accepted the confirmation but still reports "${receipt.submission_status || "no status"}"; check the assignment in a browser.`);
    action = "submitted";
  }

  return {
    ...receipt,
    action,
    ...(draftStage === undefined ? {} : { draft_stage: draftStage }),
    uploads,
    removed,
    limits,
    ...(statement ? { statement, statement_accepted: true } : {}),
    checked_at: timestamp(deps),
  };
}

/**
 * A receipt that went through the intent layer has lost its empty lists and objects to
 * stripEmpty. Callers that render it need them back; a first submission has no files
 * and removes nothing, so this is the ordinary case, not an edge.
 */
export function submissionReceiptOf(value: unknown): SubmissionReceipt {
  const receipt = record(value) as Partial<SubmissionReceipt>;
  return { ...receipt, files: receipt.files ?? [], uploads: receipt.uploads ?? [], removed: receipt.removed ?? [], limits: receipt.limits ?? {} } as SubmissionReceipt;
}

// --- Page parsing -----------------------------------------------------------

export function parseSubmissionForm(html: string, deps: Pick<AssignSubmitDeps, "baseUrl" | "fail">): SubmissionForm {
  const root = parse(html);
  const form = formWithAction(root, "savesubmission");
  if (!form) {
    const notice = noticesOf(html);
    if (root.querySelectorAll("input[type=submit], button").some(button => /begin assignment/iu.test(cleanText(button.getAttribute("value") ?? button.textContent)))) {
      throw deps.fail("This is a timed assignment; start it in a browser before uploading files.");
    }
    throw deps.fail(notice ? `Moodle is not accepting a submission: ${notice}` : "Moodle did not show a submission form for this assignment.");
  }
  const itemid = form.querySelector("input[name=files_filemanager]")?.getAttribute("value")?.trim() ?? "";
  if (!itemid) throw deps.fail("This assignment does not accept file uploads.");
  const options = filemanagerOptions(html, itemid);
  if (!options) throw deps.fail("Moodle did not describe the file upload area for this assignment.");
  const fields = formFields(form);
  const sesskey = fields.find(([name]) => name === "sesskey")?.[1] ?? "";
  if (!sesskey) throw deps.fail("The submission form has no session key.");
  const picker = record(options.filepicker);
  const repositories = (Array.isArray(picker.repositories) ? picker.repositories : Object.values(record(picker.repositories))).map(record);
  const upload = repositories.find(repo => repo.type === "upload");
  if (!upload || upload.id === undefined) throw deps.fail("The site does not allow direct file uploads for this assignment.");
  return {
    action: resolveUrl(deps.baseUrl, form.getAttribute("action") || `${deps.baseUrl}${ASSIGN_VIEW_PATH}`),
    fields,
    sesskey,
    itemid,
    clientId: String(options.client_id ?? ""),
    contextId: String(record(options.context).id ?? ""),
    repoId: String(upload.id),
    author: String(picker.author ?? ""),
    license: String(picker.defaultlicense ?? ""),
    maxBytes: integer(options.maxbytes),
    areaMaxBytes: integer(options.areamaxbytes),
    maxFiles: integer(options.maxfiles),
    acceptedTypes: acceptedTypesOf(options.accepted_types),
    ...statementOf(form),
  };
}

export function parseConfirmForm(html: string, deps: Pick<AssignSubmitDeps, "baseUrl" | "fail">): ConfirmForm {
  const root = parse(html);
  const form = formWithAction(root, "confirmsubmit");
  if (!form) {
    const notice = noticesOf(html);
    throw deps.fail(notice ? `Moodle is not accepting a submission for grading: ${notice}` : "Moodle did not show the submit-for-grading confirmation.");
  }
  return { action: resolveUrl(deps.baseUrl, form.getAttribute("action") || `${deps.baseUrl}${ASSIGN_VIEW_PATH}`), fields: formFields(form), ...statementOf(form) };
}

export function parseReceiptPage(html: string, activityId: number, baseUrl: string): Omit<SubmissionReceipt, "action" | "uploads" | "removed" | "limits" | "checked_at"> {
  const page = parseAssignmentHtml(html, activityId, baseUrl);
  const root = parse(html);
  const files = new Map<string, SubmissionFileRow>();
  const add = (link: HTMLElement) => {
    const name = cleanText(link.textContent);
    const href = link.getAttribute("href") ?? "";
    if (name && !files.has(name.toLowerCase())) files.set(name.toLowerCase(), { name, ...(href ? { url: resolveUrl(baseUrl, href) } : {}) });
  };
  for (const link of root.querySelectorAll(".fileuploadsubmission a[href]")) add(link);
  for (const link of tableCell(root, "File submissions")?.querySelectorAll("a[href]") ?? []) add(link);
  // A group submission has a "Group" row. Its files are shared, so every change reaches the
  // whole group. The row holds an error notice instead when the user has no usable group.
  const groupCell = tableCell(root, "Group");
  const group = groupCell && !groupCell.querySelector(".alert") ? cleanText(groupCell.textContent) : "";
  const pending = tableCell(root, "Submission status")?.querySelectorAll("div").find(div => /^Users who need to submit:/iu.test(cleanText(div.textContent)));
  const awaiting = pending?.querySelectorAll("a").map(link => cleanText(link.textContent)).filter(Boolean) ?? [];
  return {
    id: activityId,
    name: page.name,
    ...(page.course_id ? { unit_id: page.course_id } : {}),
    url: page.url,
    ...(group ? { group } : {}),
    ...(awaiting.length ? { awaiting } : {}),
    submission_status: page.submission_status.replace(/\s*Users who need to submit:.*$/isu, ""),
    grading_status: page.grading_status,
    due: page.due_pretty || cleanText(tableCell(root, "Due date")?.textContent),
    time_remaining: page.time_remaining,
    last_modified: cleanText(tableCell(root, "Last modified")?.textContent),
    files: [...files.values()],
  };
}

/**
 * Whether saving keeps a draft: the assignment's "require students to click the submit
 * button" setting. No page states it, but Moodle's rendering gives it away:
 * - the edit form carries the submission statement only when there is no draft stage;
 * - so a statement on the confirm page but not on the edit form means there is one;
 * - "Submit assignment" on the view page is only offered when there is one;
 * - a submitted submission that can still be edited means there is none, because Moodle
 *   locks a submitted submission when there is a draft stage.
 * Anything else is unknown.
 */
export function draftStageOf(viewHtml: string, status: string, form: Pick<SubmissionForm, "statement">, confirmHtml?: string): boolean | undefined {
  if (form.statement) return false;
  const confirm = confirmHtml === undefined ? null : formWithAction(parse(confirmHtml), "confirmsubmit");
  if (confirm && statementOf(confirm).statement) return true;
  if (formWithAction(parse(viewHtml), "submit")) return true;
  if (isSubmitted(status)) return false;
  return undefined;
}

/** Alerts and validation messages on a Moodle page, joined for an error message. */
export function noticesOf(html: string): string {
  const root = parse(html);
  const texts: string[] = [];
  for (const node of root.querySelectorAll(".alert, .invalid-feedback, .form-control-feedback, .error, [data-fieldtype] .text-danger")) {
    for (const junk of node.querySelectorAll("button, .close")) junk.remove();
    const text = cleanText(node.textContent);
    if (text && !texts.includes(text)) texts.push(text);
  }
  return texts.join(" ");
}

function formWithAction(root: HTMLElement, action: string): HTMLElement | null {
  for (const form of root.querySelectorAll("form")) {
    if (form.querySelectorAll("input[name=action]").some(input => input.getAttribute("value") === action)) return form;
  }
  return null;
}

// Fields are replayed as ordered pairs: Moodle forms repeat names such as `action`,
// and PHP keeps the last value, so order and duplicates both matter.
function formFields(form: HTMLElement): Field[] {
  const fields: Field[] = [];
  for (const element of form.querySelectorAll("input, textarea, select")) {
    const name = element.getAttribute("name");
    if (!name) continue;
    const tag = element.tagName.toLowerCase();
    if (tag === "textarea") { fields.push([name, element.textContent]); continue; }
    if (tag === "select") {
      const options = element.querySelectorAll("option");
      const chosen = options.find(option => option.hasAttribute("selected")) ?? options[0];
      if (chosen) fields.push([name, chosen.getAttribute("value") ?? cleanText(chosen.textContent)]);
      continue;
    }
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (["submit", "button", "image", "file", "reset"].includes(type)) continue;
    if ((type === "checkbox" || type === "radio") && !element.hasAttribute("checked")) continue;
    fields.push([name, element.getAttribute("value") ?? (type === "checkbox" ? "on" : "")]);
  }
  return fields;
}

function statementOf(form: HTMLElement): { statement?: string } {
  const box = form.querySelector("input[name=submissionstatement]");
  if (!box) return {};
  const id = box.getAttribute("id");
  const label = (id ? form.querySelector(`label[for="${id}"]`) : null) ?? box.closest("label") ?? box.parentNode?.querySelector("label") ?? null;
  const text = cleanText(label?.textContent).replace(/\s*Required\s*$/u, "").trim();
  return { statement: text || "Submission statement" };
}

function filemanagerOptions(html: string, itemid: string): Record<string, unknown> | null {
  const pattern = /M\.form_filemanager\.init\(\s*Y\s*,\s*/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const json = balancedObject(html, match.index + match[0].length);
    if (!json) continue;
    try {
      const options = JSON.parse(json) as unknown;
      if (isRecord(options) && String(options.itemid) === itemid) return options;
    } catch { /* Not JSON; keep scanning for the next initialiser. */ }
  }
  return null;
}

// An assignment with no file type restriction renders `"accepted_types":[]`, so an empty
// list means any type, not none. A PHP array with gaps in its keys arrives as an object.
function acceptedTypesOf(value: unknown): string[] | "*" {
  const list = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : value === undefined ? [] : [value];
  const types = list.map(type => String(type).trim()).filter(Boolean);
  return types.length === 0 || types.includes("*") ? "*" : types;
}

function balancedObject(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") { depth -= 1; if (depth === 0) return text.slice(start, index + 1); }
  }
  return null;
}

function tableCell(root: HTMLElement, label: string): HTMLElement | null {
  for (const row of root.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("th, td");
    if (cells.length > 1 && cleanText(cells[0].textContent) === label) return cells[1];
  }
  return null;
}

// --- Requests ---------------------------------------------------------------

async function pageText(deps: AssignSubmitDeps, url: string): Promise<string> {
  return (await deps.request(url)).text();
}

/** Posts a form; returns null when Moodle redirected to the view page, else the re-rendered HTML. */
async function postForm(deps: AssignSubmitDeps, action: string, fields: Field[]): Promise<string | null> {
  const response = await deps.request(action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const html = await response.text();
  return landedOnView(response.url) ? null : html;
}

function landedOnView(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.endsWith(ASSIGN_VIEW_PATH) && (parsed.searchParams.get("action") ?? "view") === "view";
  } catch {
    return false;
  }
}

async function draftAjax(deps: AssignSubmitDeps, form: SubmissionForm, action: string, params: Record<string, string>): Promise<unknown> {
  const body = new URLSearchParams({ sesskey: form.sesskey, client_id: form.clientId, itemid: form.itemid, ...params });
  const response = await deps.request(`${deps.baseUrl}/repository/draftfiles_ajax.php?action=${action}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, { allowErrorStatus: true });
  return jsonOf(deps, response, `draft file ${action}`);
}

async function listDraftFiles(deps: AssignSubmitDeps, form: SubmissionForm): Promise<DraftFile[]> {
  const data = record(await draftAjax(deps, form, "list", { filepath: "/" }));
  const list = Array.isArray(data.list) ? data.list.map(record) : [];
  return list
    .filter(item => item.type !== "folder")
    .map(item => ({ name: String(item.filename ?? item.fullname ?? ""), path: String(item.filepath ?? "/"), bytes: integer(item.size) }))
    .filter(item => item.name);
}

async function deleteDraftFiles(deps: AssignSubmitDeps, form: SubmissionForm, files: DraftFile[]): Promise<void> {
  const selected = JSON.stringify(files.map(file => ({ filename: file.name, filepath: file.path })));
  const result = await draftAjax(deps, form, "deleteselected", { selected });
  if (result === false) throw deps.fail("Moodle did not remove the existing submission files.");
}

async function uploadDraftFile(deps: AssignSubmitDeps, form: SubmissionForm, file: SubmitFile): Promise<string> {
  const body = new FormData();
  body.set("sesskey", form.sesskey);
  body.set("client_id", form.clientId);
  body.set("repo_id", form.repoId);
  body.set("itemid", form.itemid);
  body.set("env", "filemanager");
  body.set("ctx_id", form.contextId);
  body.set("title", file.name);
  body.set("author", form.author);
  body.set("license", form.license);
  body.set("savepath", "/");
  body.set("maxbytes", String(form.maxBytes));
  body.set("areamaxbytes", String(form.areaMaxBytes));
  for (const type of form.acceptedTypes === "*" ? ["*"] : form.acceptedTypes) body.append("accepted_types[]", type);
  body.set("overwrite", "1");
  // Copy into a fresh ArrayBuffer: Blob rejects views over a SharedArrayBuffer, and Node buffers may be pooled slices.
  body.set("repo_upload_file", new Blob([Uint8Array.from(file.bytes)]), file.name);
  const response = await deps.request(`${deps.baseUrl}/repository/repository_ajax.php?action=upload`, { method: "POST", body }, { allowErrorStatus: true });
  const data = record(await jsonOf(deps, response, `upload of ${file.name}`));
  if (typeof data.error === "string" && data.error) throw deps.fail(`Moodle refused ${file.name}: ${data.error}`, typeof data.errorcode === "string" ? data.errorcode : undefined);
  if (data.event === "fileexists") throw deps.fail(`Moodle reports ${file.name} already exists and did not overwrite it.`);
  const stored = typeof data.file === "string" && data.file ? data.file : file.name;
  if (!data.url && !data.id && !data.file) throw deps.fail(`Moodle did not confirm the upload of ${file.name}.`);
  return stored;
}

async function jsonOf(deps: AssignSubmitDeps, response: Response, step: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const notice = noticesOf(text);
    throw deps.fail(`Moodle did not answer the ${step} with JSON (HTTP ${response.status})${notice ? `: ${notice}` : ""}`);
  }
}

// --- Checks -----------------------------------------------------------------

function checkLimits(deps: AssignSubmitDeps, form: SubmissionForm, kept: DraftFile[], files: SubmitFile[]): void {
  if (form.maxFiles > 0 && kept.length + files.length > form.maxFiles) {
    throw deps.usage(`This assignment allows ${form.maxFiles} file${form.maxFiles === 1 ? "" : "s"}; the submission would hold ${kept.length + files.length}.`, kept.length ? "Use --replace to drop the existing files first." : undefined);
  }
  for (const file of files) {
    if (form.maxBytes > 0 && file.bytes.byteLength > form.maxBytes) throw deps.usage(`${file.name} is ${size(file.bytes.byteLength)}; the limit is ${size(form.maxBytes)}.`);
    if (form.acceptedTypes !== "*" && form.acceptedTypes.every(type => type.startsWith(".")) && !form.acceptedTypes.some(type => file.name.toLowerCase().endsWith(type.toLowerCase()))) {
      throw deps.usage(`${file.name} is not an accepted type; allowed: ${form.acceptedTypes.join(", ")}.`);
    }
  }
  const total = kept.reduce((sum, file) => sum + file.bytes, 0) + files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (form.areaMaxBytes > 0 && total > form.areaMaxBytes) throw deps.usage(`The submission would total ${size(total)}; the limit is ${size(form.areaMaxBytes)}.`, kept.length ? "Use --replace to drop the existing files first." : undefined);
}

function describeLimits(form: SubmissionForm): SubmissionLimits {
  return {
    ...(form.maxBytes > 0 ? { max_bytes: form.maxBytes } : {}),
    ...(form.maxFiles > 0 ? { max_files: form.maxFiles } : {}),
    ...(form.areaMaxBytes > 0 ? { area_max_bytes: form.areaMaxBytes } : {}),
    ...(form.acceptedTypes !== "*" ? { accepted_types: form.acceptedTypes } : {}),
  };
}

function isSubmitted(status: string): boolean {
  return /\bsubmitted\b/iu.test(status) && !/\bnot submitted\b/iu.test(status);
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function timestamp(deps: AssignSubmitDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function integer(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
