import { renderTerminalTable, sanitizeTerminalText } from "./terminal-table.js";

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(record) : [];
const text = (v: unknown): string => v == null ? "" : sanitizeTerminalText(String(v));
export function renderScreen(data: Record<string, unknown>, options: { width?: number; color?: boolean; now?: number } = {}): string {
  const lines: string[] = [];
  const now = options.now ?? Date.now();
  const dueText = (row: Record<string, unknown>) => {
    if (!row.due_at) return text(row.status || row.submission_status);
    const days = Math.ceil((Number(row.due_at) * 1000 - now) / 86400000);
    const value = `${days < 0 ? `${-days} days overdue` : days === 0 ? "today" : `in ${days} days`} · ${text(row.due)}`;
    return options.color && days <= 2 ? `\x1b[${days < 0 ? 31 : 33}m${value}\x1b[0m` : value;
  };
  const rows = (items: Record<string, unknown>[], title: string) => {
    lines.push(title);
    if (!items.length) lines.push("  None");
    for (const r of items) lines.push(`  ${text(r.unit_code || r.type)}  ${text(r.name)}${r.due_at ? `  ${dueText(r)}` : ""}${r.id ? `  #${r.id}` : ""}`);
  };
  let next = "moodle due --days 30 · moodle grades";
  if (data.home) {
    const h = record(data.home);
    lines.push(`${text(h.name)} · ${text(h.siteurl)} · ${text(h.today)} · ${text(h.timezone)}${h.timezone_source === "fallback" ? " (fallback)" : ""}`, "");
    rows(array(h.due), "Due soon");
    lines.push("", `Unread  ${Object.entries(record(h.unread)).map(([k, v]) => `${k.replaceAll("_", " ")}: ${v}`).join(" · ") || "0"}`, "", `Units  ${array(h.units).map(u => text(u.code || u.name)).join(" · ")}`);
    for (const u of array(h.units)) { const c = record(u.current_section); if (c.id) lines.push(`  ${text(u.code || u.name)} · ${text(c.name)}${(c.estimated || c.range_estimated) ? " (estimated)" : ""}${c.start ? ` · ${text(c.start).slice(0, 10)}–${text(c.end).slice(0, 10)}` : ""}`); }
    for (const e of Array.isArray(h.errors) ? h.errors : []) lines.push(`Unavailable: ${text(e)}`);
    if (Number(h.total) > array(h.due).length) lines.push(`${h.total} due items in this window; showing ${array(h.due).length}.`);
  } else if (data.unit) {
    const u = record(data.unit); const c = record(u.current_section);
    lines.push(`${text(u.code)} · ${text(u.name)}`);
    if (c.id) lines.push(`Current · ${text(c.name)}${(c.estimated || c.range_estimated) ? " (estimated)" : ""}${c.start ? ` · ${text(c.start).slice(0, 10)}–${text(c.end).slice(0, 10)}` : ""}`);
    for (const s of array(data.sections)) { lines.push(""); if (s.activities) rows(array(s.activities), `${text(s.name)}${s.positional ? " (positional index)" : ""}`); else lines.push(`${text(s.name)}  ${s.activity_count} activities`); }
    if (data.due) { lines.push(""); rows(array(data.due), "Due in this unit"); }
    if (data.news) { lines.push(""); rows(array(data.news), "Latest news"); }
    next = `moodle ${JSON.stringify(u.code || u.name)} 7 · moodle ${JSON.stringify(u.code || u.name)} grades`;
  } else if (data.grades) {
    for (const g of array(data.grades)) {
      lines.push(`${text(g.code)} · ${g.graded} of ${g.total} graded`);
      lines.push(renderTerminalTable([{ label: "Name", flex: true }, { label: "Grade" }, { label: "Range" }, { label: "Feedback", flex: true }], array(g.items).map(i => [text(i.name), text(i.grade), text(i.range), text(i.feedback || (i.due ? dueText(i) : ""))]), { width: options.width }));
    }
  } else if (data.item) {
    const i = record(data.item); lines.push(`${text(i.name)} · ${text(i.type)} · #${i.id}`);
    for (const [k, v] of Object.entries(i)) if (!["id", "name", "type", "files"].includes(k) && typeof v !== "object") lines.push(`${k.replaceAll("_", " ")}: ${text(v)}`);
    for (const f of array(i.files)) lines.push(`File  ${text(f.name)}  ${text(f.url)}`);
    if (data.threads) rows(array(data.threads), "Threads");
    next = `moodle get ${i.id} --to DIR`;
  } else if (data.thread) {
    const t = record(data.thread); lines.push(text(t.name));
    for (const p of array(t.posts)) lines.push("", `${text(record(p.author).name)} · ${text(p.created)}`, text(p.message_text), ...array(p.links).map(l => `${text(l.text)} ${text(l.url)}`));
    lines.push(`Posts ${Number(t.offset) + array(t.posts).length} of ${t.posts_total}`);
    next = `moodle threads show ${t.id} --offset ${Number(t.offset) + array(t.posts).length}`;
  } else if (data.news) {
    for (const n of array(data.news)) { const p = record(n.post); lines.push(`${text(n.unit_code)} · ${text(n.name)}`, `${text(record(p.author).name)} · ${text(p.created)}`, text(p.message_text), ""); }
  } else if (data.units) {
    lines.push(renderTerminalTable([{ label: "ID" }, { label: "Code" }, { label: "Name", flex: true }], array(data.units).map(u => [text(u.id), text(u.code), text(u.name)]), { width: options.width }));
    next = "moodle UNIT · moodle find QUERY";
  } else {
    const key = ["due", "results", "activities", "forums"].find(k => k in data);
    rows(array(key ? data[key] : []), key === "due" ? "Due" : "Matches");
    if (data.total !== undefined) lines.push(`${data.total} total`);
  }
  lines.push("", `Try  ${next}`);
  const width = Math.max(40, options.width ?? 80);
  return lines.flatMap(line => {
    if (line.includes("\x1b[") || line.startsWith("│") || /^[┌└├]/u.test(line)) return [line];
    const parts: string[] = [];
    let remaining = line;
    while (Array.from(remaining).length > width) {
      const chunk = Array.from(remaining).slice(0, width).join("");
      const boundary = chunk.lastIndexOf(" ");
      const cut = boundary > width / 2 ? boundary : chunk.length;
      parts.push(remaining.slice(0, cut)); remaining = remaining.slice(cut).trimStart();
    }
    return [...parts, remaining];
  }).join("\n");
}
