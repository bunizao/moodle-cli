import { createTheme, type Tone } from "@bunizao/cli-kit";

import { renderTerminalTable, sanitizeTerminalText, type TerminalTableCell, type TerminalTableColumn } from "./terminal-table.js";

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(record) : [];
const text = (v: unknown): string => v == null ? "" : sanitizeTerminalText(String(v));
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/u;
// Screens show the wall clock the site meant, so the ISO string is read as written
// rather than converted again into the host timezone.
function moment(value: unknown, now: number): string {
  const parts = TIMESTAMP.exec(String(value ?? ""));
  if (!parts) return text(value);
  const [, year, month, day, hour, minute] = parts;
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  const sameYear = new Date(now).getFullYear() === Number(year);
  return `${weekday} ${Number(day)} ${MONTHS[Number(month) - 1]}${sameYear ? "" : ` ${year}`}${hour ? `, ${hour}:${minute}` : ""}`;
}
// Calendar days from today to the item on the site's clock, taken from the offset its
// ISO time carries; "tomorrow" means the next date, not the next 24 hours.
function daysUntil(value: unknown, at: number, now: number): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T[\d:.]+(Z|[+-]\d{2}:\d{2})$/u.exec(String(value ?? ""));
  const offset = !parts || parts[4] === "Z" ? 0 : (parts[4][0] === "-" ? -1 : 1) * (Number(parts[4].slice(1, 3)) * 60 + Number(parts[4].slice(4))) * 60000;
  const date = (ms: number) => { const d = new Date(ms + offset); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  return Math.round((date(parts ? Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) - offset : at) - date(now)) / 86400000);
}
/** The commands worth typing next, one per line under a "Try" label, the way help pages list them. */
export function tryLines(commands: readonly string[]): string {
  return commands.map((command, index) => `${index ? "     " : "Try  "}${command}`).join("\n");
}

// intent names the command, because an empty list is dropped from the result and would
// otherwise leave nothing to say what came back empty.
export function renderScreen(data: Record<string, unknown>, options: { width?: number; color?: boolean; now?: number; intent?: string } = {}): string {
  const lines: string[] = [];
  const now = options.now ?? Date.now();
  // Three levels on every row: the code a person types next, the name they read, the facts they glance at.
  const theme = createTheme(Boolean(options.color));
  // Text and tone stay apart until the last moment: a line paints them itself, a table cell hands both over.
  const due = (row: Record<string, unknown>): { text: string; tone: Tone } => {
    const at = Number(row.due_at) * 1000;
    const days = daysUntil(row.due, at, now);
    // A quiz opening is listed with deadlines but is not one, so it says so and never alarms.
    const opens = row.event === "open";
    const when = at < now
      ? opens ? "opened" : days < 0 ? `${-days} ${days === -1 ? "day" : "days"} overdue` : "overdue"
      : `${opens ? "opens " : ""}${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}`;
    return { text: `${when} · ${moment(row.due, now)}`, tone: opens ? "muted" : at < now ? "danger" : days <= 2 ? "warning" : "muted" };
  };
  const dueText = (row: Record<string, unknown>) => {
    if (!row.due_at) return theme.status(text(row.status || row.submission_status));
    const { text: value, tone } = due(row);
    return theme.tone(tone, value);
  };
  const rows = (items: Record<string, unknown>[], title: string) => {
    lines.push(theme.subject(title));
    if (!items.length) lines.push(theme.dim("  None"));
    // A due row's own id is the calendar event's; the activity id is the one commands take.
    for (const r of items) { const id = r.activity_id ?? r.id; lines.push(`  ${theme.key(text(r.unit_code || r.type))}  ${text(r.name)}${r.due_at ? `  ${dueText(r)}` : ""}${id ? `  ${theme.dim(`#${id}`)}` : ""}`); }
  };
  let next = ["moodle due --days 30", "moodle grades"];
  if (data.home) {
    const h = record(data.home);
    lines.push(`${text(h.name)} · ${moment(h.today, now)} · ${text(h.timezone)}${h.timezone_source === "site" ? "" : ` (${text(h.timezone_source)})`}`, text(h.siteurl), "");
    rows(array(h.due), "Due soon");
    lines.push("", `Unread  ${Object.entries(record(h.unread)).map(([k, v]) => `${v} ${k.replace(/_count$/u, "").replaceAll("_", " ")}${Number(v) === 1 ? "" : "s"}`).join(" · ") || "nothing"}`, "", `Units  ${array(h.units).map(u => text(u.code || u.name)).join(" · ")}`);
    for (const u of array(h.units)) { const c = record(u.current_section); if (c.id) lines.push(`  ${text(u.code || u.name)} · ${text(c.name)}`); }
    for (const e of Array.isArray(h.errors) ? h.errors : []) lines.push(`Unavailable: ${text(e)}`);
    if (Number(h.total) > array(h.due).length) lines.push(`${h.total} due items in this window; showing ${array(h.due).length}.`);
  } else if (data.unit) {
    const u = record(data.unit); const c = record(u.current_section);
    lines.push(`${text(u.code)} · ${text(u.name)}`);
    if (c.id) lines.push(`Current · ${text(c.name)}`);
    for (const s of array(data.sections)) { lines.push(""); if (s.activities) rows(array(s.activities), `${text(s.name)}${s.positional ? " (positional index)" : ""}`); else lines.push(`${text(s.name)}  ${s.activity_count} activities`); }
    if (data.due) { lines.push(""); rows(array(data.due), "Due in this unit"); }
    if (data.news) { lines.push(""); rows(array(data.news), "Latest news"); }
    const unit = JSON.stringify(u.code || u.name);
    next = array(data.sections).some(s => s.activities) ? [`moodle ${unit} "TASK"`, `moodle dl "UNIT TASK"`] : [`moodle ${unit} SECTION`, `moodle ${unit} grades`];
  } else if (data.grades) {
    for (const g of array(data.grades)) {
      lines.push(`${text(g.code)} · ${g.graded} of ${g.total} graded`);
      const items = array(g.items);
      // Due and Feedback only appear when some row fills them, so a unit with neither keeps a narrow table.
      type Column = [TerminalTableColumn, (i: Record<string, unknown>) => TerminalTableCell];
      const columns: Column[] = [[{ label: "Name", flex: true }, i => text(i.name)], [{ label: "Grade" }, i => text(i.grade)], [{ label: "Range" }, i => text(i.range)]];
      if (items.some(i => i.due_at)) columns.push([{ label: "Due" }, i => i.due_at ? due(i) : ""]);
      if (items.some(i => i.feedback)) columns.push([{ label: "Feedback", flex: true }, i => text(i.feedback)]);
      lines.push(renderTerminalTable(columns.map(([c]) => c), items.map(i => columns.map(([, cell]) => cell(i))), { width: options.width }));
    }
  } else if (data.item) {
    const i = record(data.item); lines.push(`${text(i.name)} · ${text(i.type)} · #${i.id}`);
    // Epoch twins of the ISO fields are for machines reading --json, not for this screen.
    for (const [k, v] of Object.entries(i)) if (!["id", "name", "type", "files"].includes(k) && !k.endsWith("_at") && typeof v !== "object") lines.push(`${k.replaceAll("_", " ")}: ${moment(v, now)}`);
    for (const a of array(i.attempts)) lines.push(`Attempt ${a.number} · #${a.id}  ${[a.status, a.marks, a.grade, a.completed].map(text).filter(Boolean).join("  ·  ")}`);
    for (const c of array(i.criteria)) lines.push(`${text(c.name)}  ${[c.score, c.level, c.remark].map(text).filter(Boolean).join("  ·  ")}`);
    for (const f of array(i.files)) lines.push(`File  ${text(f.name)}  ${text(f.url)}`);
    if (data.threads) rows(array(data.threads), "Threads");
    next = array(i.files).length ? [`moodle dl ${i.id}`] : [];
  } else if (data.attempt) {
    const a = record(data.attempt); lines.push(`Attempt #${a.id} · ${[a.status, a.marks, a.grade].map(text).filter(Boolean).join(" · ")}`);
    for (const q of array(a.questions)) {
      lines.push("", `Q${q.number} · ${[q.type, q.state, q.mark].map(text).filter(Boolean).join(" · ")}`, text(q.text), `You: ${text(q.response)}`);
      if (q.correct) lines.push(`Correct: ${text(q.correct)}`);
      if (q.feedback) lines.push(`Feedback: ${text(q.feedback)}`);
    }
    next = [`moodle item ${a.quiz_id}`];
  } else if (data.thread) {
    const t = record(data.thread); lines.push(text(t.name));
    for (const p of array(t.posts)) lines.push("", `${text(record(p.author).name)} · ${moment(p.created, now)}`, text(p.message_text), ...array(p.links).map(l => `${text(l.text)} ${text(l.url)}`));
    lines.push(`Posts ${Number(t.offset) + array(t.posts).length} of ${t.posts_total}`);
    next = [`moodle threads show ${t.id} --offset ${Number(t.offset) + array(t.posts).length}`];
  } else if (data.news) {
    for (const n of array(data.news)) { const p = record(n.post); lines.push(`${text(n.unit_code)} · ${text(n.name)}`, `${text(record(p.author).name)} · ${moment(p.created, now)}`, text(p.message_text), ""); }
  } else if (data.units) {
    lines.push(renderTerminalTable([{ label: "ID" }, { label: "Code" }, { label: "Name", flex: true }], array(data.units).map(u => [text(u.id), text(u.code), text(u.name)]), { width: options.width }));
    next = ["moodle UNIT", "moodle find QUERY"];
  } else {
    const key = ["due", "results", "activities", "forums"].find(k => k in data) ?? options.intent;
    rows(array(key ? data[key] : []), key === "due" ? "Due" : key === "news" ? "News" : "Matches");
    if (data.total !== undefined) lines.push(`${data.total} total`);
  }
  lines.push("", ...tryLines(next).split("\n").map(line => theme.dim(line)));
  const width = Math.max(40, options.width || 80);
  return lines.flatMap(line => {
    if (line.includes("\x1b[") || line.startsWith("│") || /^[┌└├]/u.test(line)) return [line];
    // A wrapped row stays visibly one row: continuations keep the line's own indent.
    const indent = `${/^\s*/u.exec(line)?.[0] ?? ""}  `;
    const parts: string[] = [];
    let remaining = line;
    let room = width;
    while (Array.from(remaining).length > room) {
      const chunk = Array.from(remaining).slice(0, room).join("");
      const boundary = chunk.lastIndexOf(" ");
      const cut = boundary > room / 2 ? boundary : chunk.length;
      parts.push(`${parts.length ? indent : ""}${remaining.slice(0, cut)}`);
      remaining = remaining.slice(cut).trimStart();
      room = width - indent.length;
    }
    return [...parts, `${parts.length ? indent : ""}${remaining}`];
  }).join("\n");
}
