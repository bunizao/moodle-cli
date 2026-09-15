import type { Activity, ActivityDetail, Course, ForumPost, Section, TodoItem } from "./models.js";

export function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) { const items = value.map(stripEmpty).filter(v => v !== undefined); return items.length ? items : undefined; }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripEmpty(v)]).filter(([, v]) => v !== undefined));
  return value === "" || value === undefined ? undefined : value;
}

export function timezoneFor(value?: string): { timezone: string; timezone_source: string } {
  try { if (value && value !== "99") { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return { timezone: value, timezone_source: "site" }; } } catch { /* An invalid site timezone falls back to the host clock. */ }
  // Most profiles leave the site timezone unset, so the machine clock is the honest
  // default; a Worker resolves to UTC here and reports it as a fallback.
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host && host !== "UTC" ? { timezone: host, timezone_source: "local" } : { timezone: "UTC", timezone_source: "fallback" };
}

export function isoTime(epoch: number | undefined, timezone = "UTC"): string | undefined {
  if (!epoch) return undefined;
  const date = new Date(epoch * 1000);
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${get("timeZoneName").replace("GMT", "") || "+00:00"}`;
}
export function unitRow(c: Course, tz = "UTC") { return { id: c.id, code: c.shortname, name: c.fullname, start: isoTime(c.startdate, tz), start_at: c.startdate || undefined, end: isoTime(c.enddate, tz), end_at: c.enddate, hidden: c.visible === false ? true : undefined }; }
export function activityRow(a: Activity, section?: Section) { return { id: a.id, name: a.name, type: a.modname, section_id: section?.id, description: a.description, files: a.file_entries, hidden: a.visible === false ? true : undefined }; }
export function itemRow(a: ActivityDetail & { type: string }) {
  const { course_id, file_entries, ...detail } = a as ActivityDetail & { type: string; course_id?: number; file_entries?: unknown[] };
  return { ...detail, unit_id: course_id, files: file_entries };
}
export function dueRow(t: TodoItem, courses: Course[], tz = "UTC") {
  let activityId: number | undefined;
  try { const url = new URL(t.url); const value = Number(url.searchParams.get("id")); if (/\/mod\/[^/]+\/view.php$/u.test(url.pathname) && value > 0) activityId = value; } catch { /* Not all calendar entries link to an activity. */ }
  return { id: t.id, activity_id: activityId, name: t.activity_name || t.name, type: t.modname, unit_id: t.course_id, unit_code: courses.find(c => c.id === t.course_id)?.shortname, event: t.event_type, due: isoTime(t.due_at, tz), due_at: t.due_at, actionable: t.actionable };
}
export function postRow(p: ForumPost, subject: string, tz = "UTC") {
  return { id: p.id, parent_id: p.parent_id || undefined, name: p.subject === subject || p.subject === `Re: ${subject}` ? undefined : p.subject, author: { id: p.author.id, name: p.author.fullname }, time_created: p.time_created, created: isoTime(p.time_created, tz), message_text: p.message_text, links: p.links };
}
