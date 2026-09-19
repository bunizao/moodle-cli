import { createTheme } from "@bunizao/cli-kit";

import { renderTerminalTable, sanitizeTerminalText } from "./terminal-table.js";

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
export function renderScreen(data: Record<string, unknown>, options: { width?: number; color?: boolean; now?: number } = {}): string {
  const lines: string[] = [];
  const now = options.now ?? Date.now();
  // Three levels on every row: the code a person types next, the name they read, the facts they glance at.
  const theme = createTheme(Boolean(options.color));
  const dueText = (row: Record<string, unknown>) => {
    if (!row.due_at) return theme.status(text(row.status || row.submission_status));
    const days = Math.ceil((Number(row.due_at) * 1000 - now) / 86400000);
    const value = `${days < 0 ? `${-days} days overdue` : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`} · ${moment(row.due, now)}`;
    return days < 0 ? theme.tone("danger", value) : days <= 2 ? theme.tone("warning", value) : theme.dim(value);
  };
  const rows = (items: Record<string, unknown>[], title: string) => {
    lines.push(theme.subject(title));
    if (!items.length) lines.push(theme.dim("  None"));
    for (const r of items) lines.push(`  ${theme.key(text(r.unit_code || r.type))}  ${text(r.name)}${r.due_at ? `  ${dueText(r)}` : ""}${r.id ? `  ${theme.dim(`#${r.id}`)}` : ""}`);
  };
  let next = "moodle due --days 30 · moodle grades";
  if (data.home) {
    const h = record(data.home);
    lines.push(`${text(h.name)} · ${moment(h.today, now)} · ${text(h.timezone)}${h.timezone_source === "site" ? "" : ` (${text(h.timezone_source)})`}`, text(h.siteurl), "");
    rows(array(h.due), "Due soon");
    lines.push("", `Unread  ${Object.entries(record(h.unread)).map(([k, v]) => `${v} ${k.replace(/_count$/u, "").replaceAll("_", " ")}${Number(v) === 1 ? "" : "s"}`).join(" · ") || "nothing"}`, "", `Units  ${array(h.units).map(u => text(u.code || u.name)).join(" · ")}`);
    for (const u of array(h.units)) { const c = record(u.current_section); if (c.id) lines.push(`  ${text(u.code || u.name)} · ${text(c.name)}${c.estimated ? " (unfinished, not marked by the site)" : ""}`); }
    for (const e of Array.isArray(h.errors) ? h.errors : []) lines.push(`Unavailable: ${text(e)}`);
    if (Number(h.total) > array(h.due).length) lines.push(`${h.total} due items in this window; showing ${array(h.due).length}.`);
  } else if (data.unit) {
    const u = record(data.unit); const c = record(u.current_section);
    lines.push(`${text(u.code)} · ${text(u.name)}`);
    if (c.id) lines.push(`Current · ${text(c.name)}${c.estimated ? " (unfinished, not marked by the site)" : ""}`);
    for (const s of array(data.sections)) { lines.push(""); if (s.activities) rows(array(s.activities), `${text(s.name)}${s.positional ? " (positional index)" : ""}`); else lines.push(`${text(s.name)}  ${s.activity_count} activities`); }
    if (data.due) { lines.push(""); rows(array(data.due), "Due in this unit"); }
    if (data.news) { lines.push(""); rows(array(data.news), "Latest news"); }
    const unit = JSON.stringify(u.code || u.name);
    next = array(data.sections).some(s => s.activities) ? `moodle ${unit} "TASK" · moodle get "UNIT TASK" --to .` : `moodle ${unit} SECTION · moodle ${unit} grades`;
  } else if (data.grades) {
    for (const g of array(data.grades)) {
      lines.push(`${text(g.code)} · ${g.graded} of ${g.total} graded`);
      lines.push(renderTerminalTable([{ label: "Name", flex: true }, { label: "Grade" }, { label: "Range" }, { label: "Feedback", flex: true }], array(g.items).map(i => [text(i.name), text(i.grade), text(i.range), text(i.feedback || (i.due ? dueText(i) : ""))]), { width: options.width }));
    }
  } else if (data.item) {
    const i = record(data.item); lines.push(`${text(i.name)} · ${text(i.type)} · #${i.id}`);
    // Epoch twins of the ISO fields are for machines reading --json, not for this screen.
    for (const [k, v] of Object.entries(i)) if (!["id", "name", "type", "files"].includes(k) && !k.endsWith("_at") && typeof v !== "object") lines.push(`${k.replaceAll("_", " ")}: ${moment(v, now)}`);
    for (const f of array(i.files)) lines.push(`File  ${text(f.name)}  ${text(f.url)}`);
    if (data.threads) rows(array(data.threads), "Threads");
    next = `moodle get ${i.id} --to DIR`;
  } else if (data.thread) {
    const t = record(data.thread); lines.push(text(t.name));
    for (const p of array(t.posts)) lines.push("", `${text(record(p.author).name)} · ${moment(p.created, now)}`, text(p.message_text), ...array(p.links).map(l => `${text(l.text)} ${text(l.url)}`));
    lines.push(`Posts ${Number(t.offset) + array(t.posts).length} of ${t.posts_total}`);
    next = `moodle threads show ${t.id} --offset ${Number(t.offset) + array(t.posts).length}`;
  } else if (data.news) {
    for (const n of array(data.news)) { const p = record(n.post); lines.push(`${text(n.unit_code)} · ${text(n.name)}`, `${text(record(p.author).name)} · ${moment(p.created, now)}`, text(p.message_text), ""); }
  } else if (data.units) {
    lines.push(renderTerminalTable([{ label: "ID" }, { label: "Code" }, { label: "Name", flex: true }], array(data.units).map(u => [text(u.id), text(u.code), text(u.name)]), { width: options.width }));
    next = "moodle UNIT · moodle find QUERY";
  } else {
    const key = ["due", "results", "activities", "forums"].find(k => k in data);
    rows(array(key ? data[key] : []), key === "due" ? "Due" : "Matches");
    if (data.total !== undefined) lines.push(`${data.total} total`);
  }
  lines.push("", theme.dim(`Try  ${next}`));
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
