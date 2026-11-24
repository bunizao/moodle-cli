import { nextCalendarDay } from "./calendar-date.js";
import { quizOutcome, quizResultSummary, type Outcome } from "./quiz-outcome.js";
import type { DeadlineRow, DeadlinesView, GradeItem, GradesView, OutlineActivity, QuizView, UnitView, WidgetView } from "./views.js";

/*
 * One widget renders every show_* tool; the payload's kind picks the view. Each view
 * is one headline plus one main element. Drilling into an item happens here through
 * the host's tools/call proxy; only the "ask" buttons cost a model turn.
 */

// ---------- MCP Apps bridge ----------
// JSON-RPC over postMessage with the host frame. Hand-written: the SDK's App class
// would bundle the MCP SDK and zod into a page that does a handful of calls.

type Json = Record<string, unknown>;
interface ToolResult { content?: { type: string; text?: string }[]; structuredContent?: Json; isError?: boolean; _meta?: Json }
interface HostContext { theme?: "light" | "dark"; timeZone?: string; locale?: string; styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } } }

// Mirrors WIDGET_VIEW_KEY in widgets.ts; the bundle cannot import server code.
const VIEW_KEY = "moodle/view";
const APPS_PROTOCOL_VERSION = "2026-01-26";

let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();

function post(message: Json): void {
  window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
}

function request<T>(method: string, params: Json): Promise<T> {
  const id = nextId++;
  post({ id, method, params });
  return new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const message = event.data as Json | null;
  if (!message || message.jsonrpc !== "2.0") return;
  const id = message.id as number | undefined;
  if (id !== undefined && !("method" in message)) {
    const waiter = pending.get(id);
    pending.delete(id);
    const error = message.error as { message?: string } | undefined;
    if (error) waiter?.reject(new Error(error.message ?? "The host refused the request."));
    else waiter?.resolve(message.result);
    return;
  }
  const params = (message.params ?? {}) as Json;
  if (message.method === "ui/notifications/tool-result") showResult(params as ToolResult);
  else if (message.method === "ui/notifications/host-context-changed") applyHostContext(params as HostContext);
  else if (id !== undefined && (message.method === "ui/resource-teardown" || message.method === "ping")) post({ id, result: {} });
  else if (id !== undefined) post({ id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
});

void request<{ hostContext?: HostContext }>("ui/initialize", {
  appInfo: { name: "moodle-widget", version: "1.0.0" },
  appCapabilities: {},
  protocolVersion: APPS_PROTOCOL_VERSION,
}).then((result) => {
  if (result?.hostContext) applyHostContext(result.hostContext);
  post({ method: "ui/notifications/initialized" });
  watchSize();
});

// Same measurement as the SDK: the document's natural height, reported on change.
function watchSize(): void {
  let queued = false;
  let width = 0;
  let height = 0;
  const measure = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const doc = document.documentElement;
      const previous = doc.style.height;
      doc.style.height = "max-content";
      const nextHeight = Math.ceil(doc.getBoundingClientRect().height);
      doc.style.height = previous;
      const nextWidth = Math.ceil(window.innerWidth);
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      post({ method: "ui/notifications/size-changed", params: { width, height } });
    });
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(document.documentElement);
  observer.observe(document.body);
}

function applyHostContext(context: HostContext): void {
  const doc = document.documentElement;
  if (context.theme) {
    doc.dataset.theme = context.theme;
    doc.style.colorScheme = context.theme;
  }
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) if (value !== undefined) doc.style.setProperty(name, value);
  const fonts = context.styles?.css?.fonts;
  if (fonts && !document.getElementById("host-fonts")) document.head.append(el("style", { id: "host-fonts" }, fonts));
  if (context.locale) locale = context.locale;
  if (context.timeZone && context.timeZone !== timeZone) {
    timeZone = context.timeZone;
    render();
  }
}

function callTool(name: string, args: Json): Promise<ToolResult> {
  return request<ToolResult>("tools/call", { name, arguments: args });
}

/** Hands a question back to the model: the only interaction that costs a turn. */
function askModel(text: string): void {
  void request("ui/message", { role: "user", content: [{ type: "text", text }] });
}

function openLink(url: string): void {
  void request("ui/open-link", { url });
}

// ---------- state ----------

const root = document.getElementById("root") as HTMLElement;
let data: WidgetView | undefined;
let error: string | undefined;
let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let locale: string | undefined;
const ui = {
  drill: null as { key: string; data?: unknown } | null,
  filter: "",
  mistakesOnly: false,
  open: new Set<number>(),
  q: 0,
};

function showResult(result: ToolResult): void {
  const view = result._meta?.[VIEW_KEY] as WidgetView | undefined;
  if (result.isError || !view?.kind) {
    error = readError(result) ?? "Moodle returned nothing to show.";
    data = undefined;
  } else {
    data = view;
    error = undefined;
  }
  Object.assign(ui, { drill: null, filter: "", mistakesOnly: false, open: new Set<number>(), q: 0 });
  if (data?.kind === "unit" && data.current !== undefined) ui.open.add(data.current);
  render();
}

function readError(result: ToolResult): string | undefined {
  const structured = result.structuredContent?.error as { message?: string } | undefined;
  if (structured?.message) return structured.message;
  const text = result.content?.find((block) => block.type === "text")?.text;
  if (!text) return undefined;
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
  } catch {
    return text;
  }
}

function render(): void {
  root.replaceChildren();
  root.hidden = !data && !error;
  if (error) root.append(el("p", { class: "empty" }, error));
  else if (data?.kind === "deadlines") renderDeadlines(data);
  else if (data?.kind === "grades") renderGrades(data);
  else if (data?.kind === "quiz") renderQuiz(data);
  else if (data?.kind === "unit") renderUnit(data);
}

// ---------- helpers ----------

type Attrs = Record<string, string | boolean | null | undefined | ((event: Event) => void)>;
type Child = Node | string | null | undefined | false;

// Text always goes in as text nodes: Moodle content never becomes markup here.
function el(tag: string, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = String(value);
    else if (key === "style") node.style.cssText = String(value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function clickable(handler: () => void): Attrs {
  return {
    onclick: handler,
    onkeydown: (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        handler();
      }
    },
    role: "button",
    tabindex: "0",
  };
}

function button(label: string, onClick: () => void, primary = false): HTMLElement {
  return el("button", { class: primary ? "btn primary" : "btn", onclick: onClick, type: "button" }, label);
}

function header(title: string, subtitle: string, aside?: Child): HTMLElement {
  return el("div", { class: "w-head" },
    el("div", {}, el("h2", { class: "w-title" }, title), el("p", { class: "w-sub" }, subtitle)),
    aside);
}

function select(key: string): void {
  ui.drill = ui.drill?.key === key ? null : { key };
  render();
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function clip(text: string | undefined, length: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat;
}

const TYPE_LABELS: Record<string, string> = {
  assign: "Assignment", quiz: "Quiz", forum: "Forum", resource: "File", folder: "Folder", url: "Link", page: "Page",
  book: "Book", lesson: "Lesson", h5pactivity: "H5P", workshop: "Workshop", choice: "Choice", feedback: "Survey",
  lti: "External tool", scorm: "SCORM", glossary: "Glossary", wiki: "Wiki", data: "Database",
};

function typeLabel(type: string | undefined): string {
  return type ? TYPE_LABELS[type] ?? type : "Item";
}

/** A drill panel loads once per selection and keeps its content across re-renders. */
function drillPanel<T>(options: { key: string; title: string; load: () => Promise<T>; body: (value: T) => Node; actions: (value: T) => Child[] }): HTMLElement {
  const content = el("div", {}, el("div", { class: "loading" }, "Loading…"));
  const panel = el("div", { class: "drill" },
    el("div", { class: "drill-head" },
      el("h3", { class: "drill-title" }, options.title),
      el("button", { "aria-label": "Close", class: "icon-btn", onclick: () => { ui.drill = null; render(); }, type: "button" }, "×")),
    content);
  const fill = (value: T) => content.replaceChildren(options.body(value), el("div", { class: "drill-actions" }, options.actions(value)));
  const drill = ui.drill;
  if (drill && "data" in drill) fill(drill.data as T);
  else {
    options.load().then((value) => {
      if (ui.drill !== drill || !drill) return;
      drill.data = value;
      fill(value);
    }, (reason: unknown) => {
      content.replaceChildren(el("div", { class: "loading" }, `Couldn't load this: ${reason instanceof Error ? reason.message : String(reason)}`));
    });
  }
  return panel;
}

// ---------- item detail, shared by every view ----------

interface Item {
  id: number;
  name?: string;
  type?: string;
  url?: string;
  due?: string;
  due_pretty?: string;
  time_remaining?: string;
  availability?: string;
  submission_status?: string;
  grading_status?: string;
  grade?: string;
  graded_by?: string;
  feedback_comments?: string;
  description?: string;
  content_text?: string;
  criteria?: { name?: string; level?: string; score?: string; remark?: string }[];
  files?: { name?: string; url?: string }[];
  attempts?: { id: number; number: number; status?: string; grade?: string }[];
}

async function loadItem(ref: number): Promise<Item> {
  const result = await callTool("item", { ref });
  if (result.isError) throw new Error(readError(result) ?? "Moodle refused the request.");
  const structured = result.structuredContent ?? JSON.parse(result.content?.find((block) => block.type === "text")?.text ?? "{}") as Json;
  const item = (structured as { item?: Item }).item;
  if (!item) throw new Error("Moodle returned no item.");
  return item;
}

function itemFacts(item: Item): HTMLElement {
  const facts: [string, string | undefined][] = [
    ["Due", item.due_pretty ?? item.due],
    ["Time left", item.time_remaining],
    ["Submission", item.submission_status],
    ["Grading", item.grading_status],
    ["Grade", item.grade],
    ["Marked by", item.graded_by],
    ["Availability", item.availability],
  ];
  const summary = clip(item.description || item.content_text, 280);
  return el("div", {},
    el("dl", { class: "facts" }, facts.filter(([, value]) => value).flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value!)])),
    item.feedback_comments ? el("p", { class: "excerpt quote" }, clip(item.feedback_comments, 600)) : null,
    item.criteria?.length
      ? el("table", {}, el("tbody", {}, item.criteria.map((row) => el("tr", {},
        el("td", {}, row.name ?? ""), el("td", {}, row.level ?? ""), el("td", { class: "num" }, row.score ?? "")))))
      : null,
    item.attempts?.length
      ? el("ul", { class: "digest" }, item.attempts.map((attempt) => el("li", {},
        el("span", { class: "t" }, `Attempt ${attempt.number}`),
        el("span", { class: "m" }, [attempt.status, attempt.grade].filter(Boolean).join(" · ")),
        el("button", { class: "link", onclick: () => void openQuiz(attempt.id), type: "button" }, "Review"))))
      : null,
    item.files?.length ? el("p", { class: "meta" }, `Files: ${item.files.map((file) => file.name).filter(Boolean).join(", ")}`) : null,
    summary ? el("p", { class: "excerpt" }, summary) : null);
}

function itemActions(item: Item, ask: Child): Child[] {
  return [ask, item.url ? button("Open in Moodle", () => openLink(item.url!)) : null];
}

// Swaps the widget to the quiz review in place; a host that refuses the call or
// strips _meta from it gets the request as a chat message instead.
async function openQuiz(attempt: number): Promise<void> {
  const result = await callTool("show_quiz_review", { attempt }).catch(() => undefined);
  if (result && (result.isError || result._meta?.[VIEW_KEY])) showResult(result);
  else askModel(`Review my quiz attempt ${attempt}.`);
}

// ---------- show_deadlines ----------

function dayKey(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochSeconds * 1000));
}

function dayHeading(key: string): string {
  const today = dayKey(Date.now() / 1000);
  if (key === today) return "Today";
  if (key === nextCalendarDay(today)) return "Tomorrow";
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function clock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone });
}

function renderDeadlines(view: DeadlinesView): void {
  const units = [...new Set(view.items.map((item) => item.unit_code).filter((code): code is string => Boolean(code)))];
  const shown = view.items.filter((item) => !ui.filter || item.unit_code === ui.filter).sort((a, b) => a.due_at - b.due_at);
  root.append(header("Deadlines", `${plural(shown.length, "item")} in the next ${view.days} days`));
  if (units.length > 1) {
    root.append(el("div", { class: "chips" }, ["", ...units].map((code) => el("button", {
      "aria-pressed": String(ui.filter === code),
      class: `chip${ui.filter === code ? " on" : ""}`,
      onclick: () => { ui.filter = code; ui.drill = null; render(); },
      type: "button",
    }, code || "All"))));
  }
  if (!shown.length) {
    root.append(el("p", { class: "empty" }, "Nothing due in this window."));
    return;
  }
  const now = Date.now() / 1000;
  const list = el("div", { class: "rank" });
  let day = "";
  for (const item of shown) {
    const key = dayKey(item.due_at);
    if (key !== day) {
      day = key;
      list.append(el("div", { class: "day" }, dayHeading(key)));
    }
    const drillKey = `due:${item.id}`;
    const open = ui.drill?.key === drillKey;
    const overdue = item.due_at < now;
    list.append(el("div", {
      "aria-expanded": String(open),
      class: `rank-row${open ? " selected" : ""}`,
      ...(item.activity_id ? clickable(() => select(drillKey)) : {}),
    },
    el("div", { class: "rank-top" },
      el("span", { class: "when" }, clock(item.due_at)),
      el("span", { class: "t", title: item.name ?? "" }, item.name ?? "Untitled"),
      overdue ? el("span", { class: "flag" }, "Overdue") : null),
    el("div", { class: "meta indent" }, [item.unit_code, typeLabel(item.type)].filter(Boolean).join(" · "))));
    if (open && item.activity_id) list.append(deadlineDrill(item, drillKey));
  }
  root.append(list, el("div", { class: "nav" }, el("span"), button("Help me plan these", () => askModel(
    `Help me plan my time around these deadlines:\n${shown.slice(0, 20).map((item) =>
      `- ${dayHeading(dayKey(item.due_at))} ${clock(item.due_at)}: ${item.unit_code ?? ""} ${item.name ?? ""}`).join("\n")}`), true)));
}

function deadlineDrill(item: DeadlineRow, key: string): HTMLElement {
  return drillPanel<Item>({
    key,
    title: typeLabel(item.type),
    load: () => loadItem(item.activity_id!),
    body: itemFacts,
    actions: (detail) => itemActions(detail, button("What's left to do?", () =>
      askModel(`What do I still need to do for ${item.name ?? "this"} in ${item.unit_code ?? "this unit"} (activity ${item.activity_id})?`))),
  });
}

// ---------- show_grades ----------

function percent(item: GradeItem): number | undefined {
  const direct = Number.parseFloat((item.percentage ?? "").replace(",", "."));
  if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct));
  const grade = Number.parseFloat((item.grade ?? "").replace(",", "."));
  const max = Number.parseFloat((item.range ?? "").split(/[–-]/u).pop()?.replace(",", ".") ?? "");
  return Number.isFinite(grade) && Number.isFinite(max) && max > 0 ? Math.max(0, Math.min(100, (grade / max) * 100)) : undefined;
}

function renderGrades(view: GradesView): void {
  const marked = view.units.reduce((sum, unit) => sum + unit.items.length, 0);
  root.append(header("Grades", `${plural(view.units.length, "unit")} · ${marked} marked`));
  if (!marked) {
    root.append(el("p", { class: "empty" }, "No marked items yet."));
    return;
  }
  for (const unit of view.units.filter((row) => row.items.length)) {
    const total = unit.total_percentage ?? unit.total_grade;
    root.append(el("div", { class: "unit-head" },
      el("h3", {}, unit.code ?? `Unit ${unit.unit_id}`),
      el("span", { class: "meta" }, `${unit.graded} of ${unit.total} marked${total ? ` · total ${total}` : ""}`)));
    const rows = el("div", { class: "rows" });
    for (const item of unit.items) {
      const value = percent(item);
      const key = `grade:${unit.unit_id}:${item.id ?? item.name}`;
      const open = ui.drill?.key === key;
      rows.append(el("div", {
        "aria-expanded": String(open),
        class: `row${open ? " selected" : ""}`,
        ...(item.id ? clickable(() => select(key)) : {}),
      },
      el("span", { class: "row-label", title: item.name ?? "" }, item.name ?? "Item"),
      el("span", { class: "meter", "aria-hidden": "true" }, value === undefined ? null : el("i", { style: `width:${value}%` })),
      el("span", { class: "row-count" }, item.grade ? `${item.grade}${item.range ? ` / ${item.range.split(/[–-]/u).pop()?.trim()}` : ""}` : "–")));
      if (open && item.id) rows.append(el("div", { class: "row-drill" }, gradeDrill(unit.code, item, key)));
    }
    root.append(rows);
  }
}

function gradeDrill(code: string | undefined, item: GradeItem, key: string): HTMLElement {
  return drillPanel<Item>({
    key,
    title: "Marker feedback",
    load: () => loadItem(item.id!),
    body: itemFacts,
    actions: (detail) => itemActions(detail, button("Explain this feedback", () =>
      askModel(`Explain the marker feedback on ${item.name ?? "this item"} in ${code ?? "this unit"} (activity ${item.id}) and what I should do differently next time.`))),
  });
}

// ---------- show_quiz_review ----------

const OUTCOME_LABELS: Record<Outcome, string> = { right: "Full marks", partial: "Part marks", wrong: "No marks", open: "Not marked" };

function renderQuiz(view: QuizView): void {
  const { attempt } = view;
  const all = attempt.questions;
  const questions = ui.mistakesOnly ? all.filter((question) => ["wrong", "partial"].includes(quizOutcome(question))) : all;
  const missed = all.filter((question) => ["wrong", "partial"].includes(quizOutcome(question)));
  ui.q = Math.min(ui.q, Math.max(questions.length - 1, 0));
  root.append(header("Quiz review", [attempt.grade && `Grade ${attempt.grade}`, attempt.marks && `${attempt.marks} marks`, attempt.duration].filter(Boolean).join(" · ") || `Attempt ${attempt.id}`,
    missed.length ? el("button", { class: "w-toggle", onclick: () => { ui.mistakesOnly = !ui.mistakesOnly; ui.q = 0; render(); }, type: "button" }, ui.mistakesOnly ? "All questions" : "Only mistakes") : null));
  if (!all.length) {
    root.append(el("p", { class: "empty" }, "Moodle shows no questions for this attempt; the review may not be open yet."));
    return;
  }
  root.append(el("div", { class: "dots", role: "tablist" }, questions.map((question, index) => el("button", {
    "aria-label": `Question ${question.number}: ${OUTCOME_LABELS[quizOutcome(question)]}`,
    "aria-selected": String(index === ui.q),
    class: `dot ${quizOutcome(question)}${index === ui.q ? " on" : ""}`,
    onclick: () => { ui.q = index; render(); },
    role: "tab",
    type: "button",
  }, String(question.number)))));
  const question = questions[ui.q];
  if (question) {
    const result = quizOutcome(question);
    root.append(el("div", { class: "card" },
      el("div", { class: "card-head" },
        el("span", {}, `Question ${question.number}`),
        el("span", { class: `badge ${result}` }, [question.state || OUTCOME_LABELS[result], question.mark].filter(Boolean).join(" · "))),
      question.text ? el("p", { class: "question" }, question.text) : null,
      answer("Your answer", question.response ?? "No answer", result === "right" ? "right" : result === "open" ? "" : "wrong"),
      question.correct ? answer("Correct answer", question.correct, "right") : null,
      question.feedback ? el("p", { class: "excerpt quote" }, question.feedback) : null));
  }
  root.append(el("div", { class: "nav" },
    el("button", { class: "link", disabled: ui.q === 0, onclick: () => { ui.q -= 1; render(); }, type: "button" }, "Back"),
    ui.q < questions.length - 1
      ? button("Next", () => { ui.q += 1; render(); }, true)
      : missed.length
        ? button("Go over my mistakes", () => askModel(`Go over the questions I lost marks on in quiz attempt ${attempt.id}:\n${missed.map((item) =>
          `- Q${item.number} (${item.mark ?? item.state ?? "no mark"}): ${clip(item.text, 200)}`).join("\n")}`), true)
        : el("span", { class: "meta" }, quizResultSummary(all))));
}

function answer(label: string, text: string, tone: string): HTMLElement {
  return el("div", { class: `answer ${tone}` }, el("span", { class: "meta" }, label), el("p", {}, text));
}

// ---------- show_unit ----------

function renderUnit(view: UnitView): void {
  const count = view.sections.reduce((sum, section) => sum + section.activities.length, 0);
  root.append(header([view.unit.code, view.unit.name].filter(Boolean).join(" · ") || `Unit ${view.unit.id}`,
    `${plural(view.sections.length, "section")} · ${count} ${count === 1 ? "activity" : "activities"}`));
  const list = el("div", { class: "outline" });
  for (const section of view.sections) {
    const open = ui.open.has(section.id);
    list.append(el("div", {
      "aria-expanded": String(open),
      class: `section${open ? " open" : ""}${section.hidden ? " muted" : ""}`,
      ...clickable(() => { if (open) ui.open.delete(section.id); else ui.open.add(section.id); render(); }),
    },
    el("span", { class: "caret", "aria-hidden": "true" }, open ? "▾" : "▸"),
    el("span", { class: "t" }, section.name ?? `Section ${section.id}`),
    section.id === view.current ? el("span", { class: "badge right" }, "Current") : null,
    el("span", { class: "m" }, String(section.activities.length))));
    if (!open) continue;
    if (!section.activities.length) list.append(el("p", { class: "meta indent" }, "Nothing here yet."));
    for (const activity of section.activities) {
      const key = `act:${activity.id}`;
      const selected = ui.drill?.key === key;
      list.append(el("div", {
        "aria-expanded": String(selected),
        class: `activity${selected ? " selected" : ""}${activity.hidden ? " muted" : ""}`,
        ...clickable(() => select(key)),
      },
      el("span", { class: "type" }, typeLabel(activity.type)),
      el("span", { class: "t", title: activity.name ?? "" }, activity.name ?? "Untitled")));
      if (selected) list.append(activityDrill(view, activity, key));
    }
  }
  root.append(list);
}

function activityDrill(view: UnitView, activity: OutlineActivity, key: string): HTMLElement {
  return drillPanel<Item>({
    key,
    title: typeLabel(activity.type),
    load: () => loadItem(activity.id),
    body: itemFacts,
    actions: (detail) => itemActions(detail, button("Summarise this", () =>
      askModel(`Summarise ${activity.name ?? "this item"} from ${view.unit.code ?? `unit ${view.unit.id}`} (activity ${activity.id}).`))),
  });
}
