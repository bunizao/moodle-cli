import { parse, type HTMLElement } from "node-html-parser";

import { QUIZ_ATTEMPT_PATH, QUIZ_PROCESS_PATH, QUIZ_REVIEW_PATH, QUIZ_START_PATH, QUIZ_SUMMARY_PATH, QUIZ_VIEW_PATH } from "./constants.js";
import { cleanText, resolveUrl } from "./html-utils.js";
import { blockText, parseQuizHtml, parseQuizReviewHtml } from "./scraper.js";
import type { QuizAttemptReview } from "./models.js";

// Taking a quiz replays the browser flow: the view page's "Attempt quiz" form starts
// an attempt, each attempt page is a form posted to processattempt.php, and the
// summary page's form finishes it. Nothing is assumed from a request having been
// sent; every write is verified against the page Moodle renders afterwards.

export interface QuizDeps {
  baseUrl: string;
  request(url: string, init?: RequestInit, options?: { allowErrorStatus?: boolean }): Promise<Response>;
  /** Moodle refused or mangled a step; the message is shown to the user as-is. */
  fail(message: string, moodleErrorCode?: string): Error;
  /** The request cannot succeed as given; the caller can change it. */
  usage(message: string, hint?: string): Error;
}

export type QuestionKind = "choice" | "multi" | "text" | "info" | "unsupported";

export interface AttemptOption {
  /** Letter shown to the user: a, b, c... */
  key: string;
  /** The input this option belongs to; boxes of a multiple choice each have their own. */
  field: string;
  /** The value Moodle stores for that input. */
  value: string;
  text: string;
  chosen: boolean;
}

export interface AttemptQuestion {
  slot: number;
  /** Moodle's display number; "i" for an information block. */
  number: string;
  type: string;
  kind: QuestionKind;
  state: string;
  text: string;
  /** The input a written or single-choice answer is posted to. */
  field?: string;
  options?: AttemptOption[];
  /** Current free-text answer, when the question takes one. */
  answer?: string;
}

export interface AttemptNavEntry {
  slot: number;
  number: string;
  page: number;
  state: string;
}

export interface AttemptPage {
  attempt: number;
  quiz_id: number;
  name: string;
  page: number;
  pages: number;
  questions: AttemptQuestion[];
  navigation: AttemptNavEntry[];
  url: string;
}

export interface AttemptSummary {
  attempt: number;
  quiz_id: number;
  name: string;
  rows: Array<{ number: string; state: string; page: number }>;
  url: string;
}

export interface AttemptFinishReceipt {
  attempt: number;
  quiz_id: number;
  name: string;
  /** Question states as the summary listed them just before finishing. */
  summary: AttemptSummary["rows"];
  review?: QuizAttemptReview;
  /** Attempt row from the quiz page when the site withholds the review. */
  result?: { status: string; marks: string; grade: string; completed: string };
  url: string;
}

type Field = [string, string];

export interface StartOptions {
  /** Asked once when the quiz has an access password; null means the person declined. */
  password?: () => Promise<string | null>;
}

export async function startQuizAttempt(deps: QuizDeps, quizId: number, options: StartOptions = {}): Promise<AttemptPage> {
  if (!Number.isSafeInteger(quizId) || quizId <= 0) throw deps.usage("The quiz id must be a positive integer.");
  const viewUrl = `${deps.baseUrl}${QUIZ_VIEW_PATH}?id=${quizId}`;
  const viewHtml = await pageText(deps, viewUrl);
  const root = parse(viewHtml);
  if (/safeexambrowser|Safe Exam Browser/iu.test(viewHtml)) throw deps.usage("This quiz requires the Safe Exam Browser, which the CLI cannot provide.", "Open it in the browser Moodle asks for.");
  // An attempt already under way shows a "Continue" button that lands on the attempt page directly.
  const resume = formWithAction(root, QUIZ_ATTEMPT_PATH) ?? root.querySelector(`a[href*="${QUIZ_ATTEMPT_PATH}?"]`);
  if (resume) {
    const target = resume.tagName.toLowerCase() === "form"
      ? `${resolveUrl(deps.baseUrl, resume.getAttribute("action") ?? "")}?${new URLSearchParams(formFields(resume)).toString()}`
      : resolveUrl(deps.baseUrl, resume.getAttribute("href") ?? "");
    const attempt = numberParam(target, "attempt");
    if (attempt) return getAttemptPage(deps, attempt, quizId, 0);
  }
  const start = formWithAction(root, QUIZ_START_PATH);
  if (!start) {
    const reason = cleanText(root.querySelector(".quizattempt, .quizinfo")?.textContent) || "the quiz page shows no attempt button";
    throw deps.usage(`Moodle offers no new attempt: ${reason}`, `See ${viewUrl}`);
  }
  let response = await deps.request(resolveUrl(deps.baseUrl, start.getAttribute("action") ?? ""), postInit(formFields(start)));
  let html = await response.text();
  // A timed or password-protected quiz answers with a pre-flight form instead of the attempt.
  if (!onPath(response.url, QUIZ_ATTEMPT_PATH)) {
    const preflight = formWithAction(parse(html), QUIZ_START_PATH);
    if (!preflight) throw deps.fail(`Moodle did not start the attempt: ${noticesOf(html) || "it returned an unexpected page"}`);
    const fields: Field[] = [...formFields(preflight).filter(([name]) => name !== "quizpassword"), ["submitbutton", "Start attempt"]];
    // The quiz access password is the one the teacher hands out; it is asked for, never guessed or stored.
    if (preflight.querySelector("input[name=quizpassword]")) {
      const password = options.password ? await options.password() : null;
      if (!password) throw deps.usage("This quiz needs its access password to start.", "Run moodle quiz start again at a terminal to be asked for it, or pass --password.");
      fields.push(["quizpassword", password]);
    }
    response = await deps.request(resolveUrl(deps.baseUrl, preflight.getAttribute("action") ?? ""), postInit(fields));
    html = await response.text();
    if (!onPath(response.url, QUIZ_ATTEMPT_PATH)) throw deps.fail(`Moodle did not start the attempt: ${noticesOf(html) || "it returned the pre-flight form again"}`);
  }
  return withoutForm(parseAttemptPage(html, response.url, deps));
}

export async function getAttemptPage(deps: QuizDeps, attemptId: number, quizId: number, page: number): Promise<AttemptPage> {
  return withoutForm(await loadAttemptPage(deps, attemptId, quizId, page));
}

async function loadAttemptPage(deps: QuizDeps, attemptId: number, quizId: number, page: number): Promise<ParsedAttemptPage> {
  const url = attemptUrl(deps.baseUrl, attemptId, quizId, page);
  const response = await deps.request(url);
  const html = await response.text();
  if (onPath(response.url, QUIZ_REVIEW_PATH)) throw deps.usage(`Attempt ${attemptId} is already finished.`, `Its review is at ${response.url}`);
  if (!onPath(response.url, QUIZ_ATTEMPT_PATH)) throw deps.fail(`Moodle did not show attempt ${attemptId}: ${noticesOf(html) || "it redirected elsewhere"}`);
  return parseAttemptPage(html, response.url, deps);
}

// The form carries the sesskey; it never leaves this module.
function withoutForm({ form: _form, ...page }: ParsedAttemptPage): AttemptPage {
  return page;
}

export interface AnswerRequest {
  attemptId: number;
  quizId: number;
  /** Display number of the question, as `moodle quiz show` lists it. */
  question: string;
  /** Option letters ("b", "a,c") for choice questions; the response text otherwise. */
  value: string;
}

/** Saves one answer and returns the page it lives on, re-read after the save. */
export async function answerQuizQuestion(deps: QuizDeps, request: AnswerRequest): Promise<AttemptPage> {
  const first = await loadAttemptPage(deps, request.attemptId, request.quizId, 0);
  const entry = first.navigation.find(item => item.number === request.question.trim());
  if (!entry) throw deps.usage(`Attempt ${request.attemptId} has no question ${request.question}.`, `Questions: ${first.navigation.map(item => item.number).join(", ")}`);
  const page = entry.page === first.page ? first : await loadAttemptPage(deps, request.attemptId, request.quizId, entry.page);
  const question = page.questions.find(item => item.slot === entry.slot);
  if (!question) throw deps.fail(`Page ${entry.page + 1} does not contain question ${request.question}.`);
  const fields = encodeAnswer(deps, page.form, question, request.value);
  // Posting nextpage = thispage keeps Moodle on the same page, so the re-rendered page is the receipt.
  const replay = fields.map(([name, value]): Field => (name === "nextpage" ? [name, String(page.page)] : [name, value]));
  const response = await deps.request(page.form.action, postInit(replay));
  const html = await response.text();
  if (!onPath(response.url, QUIZ_ATTEMPT_PATH)) throw deps.fail(`Moodle did not save the answer: ${noticesOf(html) || "it left the attempt page"}`);
  const after = parseAttemptPage(html, response.url, deps);
  const saved = after.questions.find(item => item.slot === question.slot);
  if (!saved || /not yet answered|not answered/iu.test(saved.state)) throw deps.fail(`Moodle accepted the post but still reports question ${request.question} as "${saved?.state || "missing"}".`);
  return withoutForm(after);
}

export async function getAttemptSummary(deps: QuizDeps, attemptId: number, quizId: number): Promise<AttemptSummary> {
  const { form: _form, ...summary } = await loadAttemptSummary(deps, attemptId, quizId);
  return summary;
}

async function loadAttemptSummary(deps: QuizDeps, attemptId: number, quizId: number): Promise<AttemptSummary & { form: ParsedForm }> {
  const url = `${deps.baseUrl}${QUIZ_SUMMARY_PATH}?attempt=${attemptId}&cmid=${quizId}`;
  const response = await deps.request(url);
  const html = await response.text();
  if (onPath(response.url, QUIZ_REVIEW_PATH)) throw deps.usage(`Attempt ${attemptId} is already finished.`, `Its review is at ${response.url}`);
  const root = parse(html);
  const rows = root.querySelectorAll("table.quizsummaryofattempt tbody tr").flatMap(row => {
    const cells = row.querySelectorAll("td");
    if (cells.length < 2) return [];
    const link = cells[0].querySelector("a")?.getAttribute("href") ?? "";
    return [{ number: cleanText(cells[0].textContent), state: cleanText(cells[1].textContent), page: numberParam(link, "page") ?? 0 }];
  });
  const finish = root.querySelector("form#frm-finishattempt") ?? formWithAction(root, QUIZ_PROCESS_PATH);
  if (!finish || !rows.length) throw deps.fail(`Moodle did not show the summary of attempt ${attemptId}: ${noticesOf(html) || "the page has no finish button"}`);
  const form = { action: resolveUrl(deps.baseUrl, finish.getAttribute("action") ?? ""), fields: formFields(finish) };
  return { attempt: attemptId, quiz_id: quizId, name: pageHeading(root), rows, url, form };
}

/** Submits every saved answer for grading. Moodle treats this as final. */
export async function finishQuizAttempt(deps: QuizDeps, attemptId: number, quizId: number): Promise<AttemptFinishReceipt> {
  const summary = await loadAttemptSummary(deps, attemptId, quizId);
  const response = await deps.request(summary.form.action, postInit(summary.form.fields));
  const html = await response.text();
  const receipt: AttemptFinishReceipt = { attempt: attemptId, quiz_id: quizId, name: summary.name, summary: summary.rows, url: response.url };
  if (onPath(response.url, QUIZ_REVIEW_PATH)) {
    receipt.review = parseQuizReviewHtml(html, attemptId, deps.baseUrl);
    return receipt;
  }
  // Sites that hide the review send the learner back to the quiz page; its attempt list is the proof.
  const quiz = parseQuizHtml(onPath(response.url, QUIZ_VIEW_PATH) ? html : await pageText(deps, `${deps.baseUrl}${QUIZ_VIEW_PATH}?id=${quizId}`), quizId, deps.baseUrl);
  const row = quiz.attempts.find(attempt => attempt.id === attemptId);
  if (row && /in progress/iu.test(row.status)) throw deps.fail(`Moodle accepted the finish request but still lists attempt ${attemptId} as ${row.status}; check the quiz in a browser.`);
  receipt.url = quiz.url;
  if (row) { receipt.result = { status: row.status, marks: row.marks, grade: row.grade, completed: row.completed }; return receipt; }
  // A site that withholds the review lists the attempt without a link, so the list cannot name it.
  // The attempt page itself is the tie-breaker: an open attempt still renders its response form.
  const probe = await deps.request(attemptUrl(deps.baseUrl, attemptId, quizId, 0));
  if (onPath(probe.url, QUIZ_ATTEMPT_PATH) && parse(await probe.text()).querySelector("form#responseform")) throw deps.fail(`Moodle accepted the finish request but attempt ${attemptId} is still open; check the quiz in a browser.`);
  return receipt;
}

interface ParsedForm {
  action: string;
  fields: Field[];
}

interface ParsedAttemptPage extends AttemptPage {
  form: ParsedForm;
}

export function parseAttemptPage(html: string, url: string, deps: Pick<QuizDeps, "baseUrl" | "fail">): ParsedAttemptPage {
  const root = parse(html);
  const form = root.querySelector("form#responseform");
  if (!form) throw deps.fail(`Moodle did not render an attempt page: ${noticesOf(html) || "no response form found"}`);
  const attempt = numberParam(url, "attempt") ?? Number(form.querySelector("input[name=attempt]")?.getAttribute("value"));
  const quizId = numberParam(form.getAttribute("action") ?? "", "cmid") ?? numberParam(url, "cmid") ?? 0;
  const page = Number(form.querySelector("input[name=thispage]")?.getAttribute("value") ?? numberParam(url, "page") ?? 0);
  const navigation = root.querySelectorAll("a.qnbutton").map(button => {
    const title = button.getAttribute("title") ?? "";
    const match = title.match(/^(?:Question|Information)?\s*(\S+)\s*-\s*(.+)$/u);
    return {
      slot: Number(button.getAttribute("id")?.replace(/^quiznavbutton/u, "") ?? 0),
      number: match?.[1] ?? cleanText(button.textContent),
      page: Number(button.getAttribute("data-quiz-page") ?? 0),
      state: match?.[2] ?? "",
    };
  });
  const questions = form.querySelectorAll("div.que").map(parseAttemptQuestion);
  return {
    attempt,
    quiz_id: quizId,
    name: pageHeading(root),
    page,
    pages: Math.max(page + 1, ...navigation.map(entry => entry.page + 1)),
    questions,
    navigation,
    url: attemptUrl(deps.baseUrl, attempt, quizId, page),
    form: { action: resolveUrl(deps.baseUrl, form.getAttribute("action") ?? ""), fields: formFields(form) },
  };
}

// Inputs decide what a question takes; the qtype class only names it. Radios are a
// single choice, checkboxes a multiple choice, one text field a written answer.
function parseAttemptQuestion(que: HTMLElement): AttemptQuestion {
  const slot = Number(que.getAttribute("id")?.split("-").at(-1) ?? 0);
  const base: AttemptQuestion = {
    slot,
    number: cleanText(que.querySelector(".info .qno, .info .no")?.textContent).replace(/^Question\s*/iu, "") || "i",
    type: que.classList.value[1] ?? "",
    kind: "unsupported",
    state: cleanText(que.querySelector(".info .state")?.textContent),
    text: blockText(que.querySelector(".qtext")),
  };
  if (que.classList.contains("description")) return { ...base, number: "i", kind: "info" };
  const inputs = que.querySelectorAll("input, textarea, select").filter(input => {
    const name = input.getAttribute("name") ?? "";
    return name.startsWith("q") && !/_:(?:flagged|sequencecheck)$|_-seen$|_answerformat$/u.test(name) && !/^(?:hidden|submit)$/u.test(input.getAttribute("type") ?? "");
  });
  const tag = (input: HTMLElement) => input.tagName.toLowerCase();
  const type = (input: HTMLElement) => (tag(input) === "input" ? (input.getAttribute("type") ?? "text").toLowerCase() : tag(input));
  // "Clear my choice" is a hidden radio; it is told apart by its markup, not by its value,
  // because -1 is a perfectly good numerical answer.
  const isClearChoice = (input: HTMLElement) => type(input) === "radio" && (input.closest(".qtype_multichoice_clearchoice") !== null || input.getAttribute("aria-hidden") === "true");
  const radios = inputs.filter(input => type(input) === "radio" && !isClearChoice(input));
  const boxes = inputs.filter(input => type(input) === "checkbox");
  const texts = inputs.filter(input => ["textarea", "text", "number"].includes(type(input)));
  const selects = inputs.filter(input => type(input) === "select");
  const others = inputs.length - radios.length - boxes.length - texts.length - selects.length - inputs.filter(isClearChoice).length;
  // One group of inputs is answerable; a cloze or matching question mixes several and stays a browser job.
  const radioNames = new Set(radios.map(input => input.getAttribute("name")));
  const only = (group: HTMLElement[]) => group.length === inputs.length - inputs.filter(isClearChoice).length && others === 0;
  if (radios.length && radioNames.size === 1 && only(radios)) {
    return { ...base, kind: "choice", field: radios[0].getAttribute("name")!, options: radios.map((input, index) => option(que, input, index)) };
  }
  if (boxes.length && only(boxes)) return { ...base, kind: "multi", options: boxes.map((input, index) => option(que, input, index)) };
  if (selects.length === 1 && only(selects)) {
    const select = selects[0];
    const name = select.getAttribute("name")!;
    // The blank "Choose..." entry is Moodle's placeholder, not an answer.
    const choices = select.querySelectorAll("option").filter(item => (item.getAttribute("value") ?? "") !== "");
    return { ...base, kind: "choice", field: name, options: choices.map((item, index) => ({ key: String.fromCharCode(97 + index), field: name, value: item.getAttribute("value") ?? "", text: cleanText(item.textContent), chosen: item.hasAttribute("selected") })) };
  }
  if (texts.length === 1 && only(texts)) {
    const text = texts[0];
    // Editor-backed essays hold HTML in the textarea; a plain field holds the answer itself.
    const html = tag(text) === "textarea";
    return { ...base, kind: "text", field: text.getAttribute("name")!, answer: html ? blockText(parse(text.textContent)) : cleanText(text.getAttribute("value") ?? "") };
  }
  return base;
}

function option(que: HTMLElement, input: HTMLElement, index: number): AttemptOption {
  const labelId = input.getAttribute("aria-labelledby");
  const id = input.getAttribute("id");
  const label = (labelId ? que.querySelector(`[id="${labelId}"]`) : null) ?? (id ? que.querySelector(`label[for="${id}"]`) : null) ?? input.parentNode;
  // An option that is only an image has no text; its alt text, or a marker, keeps the letter usable.
  const text = blockText(label) || label?.querySelectorAll("img").map(img => cleanText(img.getAttribute("alt"))).filter(Boolean).join(" ") || "(image; see the quiz in a browser)";
  return { key: String.fromCharCode(97 + index), field: input.getAttribute("name") ?? "", value: input.getAttribute("value") ?? "", text, chosen: input.hasAttribute("checked") };
}

function encodeAnswer(deps: QuizDeps, form: ParsedForm, question: AttemptQuestion, value: string): Field[] {
  const raw = value.trim();
  if (question.kind === "info") throw deps.usage(`Question ${question.number} is an information block; it takes no answer.`);
  if (question.kind === "unsupported" || (!question.field && question.kind !== "multi")) throw deps.usage(`Question ${question.number} is a ${question.type || "question"} type the CLI cannot answer.`, "Answer it in a browser; other questions can still be answered here.");
  if (question.kind === "text") {
    if (!raw) throw deps.usage(`Question ${question.number} needs a written answer.`);
    // answerformat 1 is HTML; plain (2), Markdown (4) and Moodle auto-format (0) take the text as typed.
    const format = form.fields.find(([name]) => name === `${question.field}format`)?.[1];
    return [...form.fields.filter(([name]) => name !== question.field), [question.field!, format === "1" ? paragraphs(value) : raw]];
  }
  const options = question.options ?? [];
  const picks = raw.split(",").map(part => part.trim()).filter(Boolean).map(part => {
    const match = options.find(item => item.key === part.toLowerCase()) ?? options.find(item => cleanText(item.text).toLowerCase() === part.toLowerCase());
    if (!match) throw deps.usage(`Question ${question.number} has no option '${part}'.`, `Choose from ${options.map(item => item.key).join(", ")}.`);
    return match;
  });
  if (!picks.length) throw deps.usage(`Question ${question.number} needs an option letter.`, `Choose from ${options.map(item => item.key).join(", ")}.`);
  if (question.kind === "choice") {
    if (picks.length > 1) throw deps.usage(`Question ${question.number} takes one option, not ${picks.length}.`);
    return [...form.fields.filter(([name]) => name !== question.field), [question.field!, picks[0].value]];
  }
  // Every checkbox carries value 1; the letter identifies the box, not the value.
  const chosen = new Set(picks.map(pick => pick.key));
  const boxNames = new Set(options.map(item => item.field));
  return [
    ...form.fields.filter(([name]) => !boxNames.has(name)),
    ...options.map((item): Field => [item.field, chosen.has(item.key) ? "1" : "0"]),
  ];
}

export function noticesOf(html: string): string {
  const root = parse(html);
  const texts: string[] = [];
  for (const node of root.querySelectorAll(".alert, .errorbox, .error, #notice")) {
    for (const junk of node.querySelectorAll("button, .close")) junk.remove();
    const text = cleanText(node.textContent);
    if (text && !texts.includes(text)) texts.push(text);
  }
  return texts.join(" ");
}

function formWithAction(root: HTMLElement, path: string): HTMLElement | null {
  return root.querySelectorAll("form").find(form => onPath(form.getAttribute("action") ?? "", path)) ?? null;
}

// Fields are replayed as ordered pairs so duplicate names keep the order Moodle expects.
function formFields(form: HTMLElement): Field[] {
  const fields: Field[] = [];
  for (const element of form.querySelectorAll("input, textarea, select")) {
    const name = element.getAttribute("name");
    if (!name) continue;
    const tag = element.tagName.toLowerCase();
    if (tag === "textarea") { fields.push([name, element.textContent]); continue; }
    if (tag === "select") {
      const options = element.querySelectorAll("option");
      const chosen = options.find(item => item.hasAttribute("selected")) ?? options[0];
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

function postInit(fields: Field[]): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
}

async function pageText(deps: QuizDeps, url: string): Promise<string> {
  return (await deps.request(url)).text();
}

function attemptUrl(baseUrl: string, attempt: number, quizId: number, page: number): string {
  return `${baseUrl}${QUIZ_ATTEMPT_PATH}?attempt=${attempt}&cmid=${quizId}${page ? `&page=${page}` : ""}`;
}

// Themes put screen-reader headings such as "Blocks" before the page's own h1;
// the header region carries the quiz name, and the title tag is the fallback.
function pageHeading(root: HTMLElement): string {
  const heading = cleanText(root.querySelector(".page-header-headings h1, #page-header h1")?.textContent);
  if (heading) return heading;
  const title = cleanText(root.querySelector("title")?.textContent).replace(/\s*\(page \d+ of \d+\)/iu, "").split(" | ")[0].trim();
  return title || cleanText(root.querySelector("h2")?.textContent);
}

function onPath(url: string, path: string): boolean {
  try {
    return new URL(url, "https://moodle.invalid").pathname.endsWith(path);
  } catch {
    return false;
  }
}

function numberParam(url: string, key: string): number | null {
  try {
    const value = Number(new URL(url, "https://moodle.invalid").searchParams.get(key));
    return Number.isSafeInteger(value) && value > 0 ? value : (key === "page" && value === 0 ? 0 : null);
  } catch {
    return null;
  }
}

// Essays are stored as HTML (answerformat 1): blank lines become paragraphs, single breaks stay breaks.
function paragraphs(text: string): string {
  const escaped = text.trim().replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return escaped.split(/\n\s*\n/u).map(block => `<p>${block.trim().replace(/\n/gu, "<br>")}</p>`).join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
