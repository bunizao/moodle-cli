import { asArray, asRecord } from "./parsers.js";
import { FUNC_GET_CALENDAR_MONTH } from "./constants.js";
import { htmlToStructuredContent, resolveUrl } from "./html-utils.js";
import type { CalendarEvent } from "./models.js";

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const rows = (value: unknown) => asArray(value).map(asRecord);

export async function readCalendar(call: Call, baseUrl: string, days: number, courseId?: number): Promise<CalendarEvent[]> {
  const now = Math.floor(Date.now() / 1000);
  const end = now + days * 86400;
  const events = new Map<number, CalendarEvent>();
  // Upcoming view silently truncates at the user's calendar preferences. Month views
  // include all events; a day either side covers the site's timezone at month edges.
  const month = new Date((now - 86400) * 1000);
  month.setUTCDate(1);
  while (month.getTime() <= (end + 86400) * 1000) {
    for (const event of await readCalendarMonth(call, baseUrl, month.getUTCFullYear(), month.getUTCMonth() + 1, courseId)) {
      if (event.starts_at > end || event.starts_at + event.duration < now || (courseId !== undefined && event.course_id !== courseId)) continue;
      events.set(event.id, event);
    }
    month.setUTCMonth(month.getUTCMonth() + 1);
  }
  return [...events.values()].sort((a, b) => a.starts_at - b.starts_at || a.id - b.id);
}

export async function readCalendarMonth(call: Call, baseUrl: string, year: number, month: number, courseId?: number): Promise<CalendarEvent[]> {
  const data = asRecord(await call(FUNC_GET_CALENDAR_MONTH, { year, month, courseid: courseId ?? 1, includenavigation: false, mini: false }));
  const events = new Map<number, CalendarEvent>();
  const monthEvents = rows(data.weeks).flatMap(week => rows(week.days)).flatMap(day => rows(day.events));
  for (const event of monthEvents) {
    const course = asRecord(event.course);
    const id = Number(event.id);
    const starts = Number(event.timestart);
    if (!Number.isSafeInteger(id) || !Number.isFinite(starts)) continue;
    events.set(id, {
      id,
      name: htmlToStructuredContent(String(event.name ?? ""), baseUrl).text,
      description: htmlToStructuredContent(String(event.description ?? ""), baseUrl).text,
      starts_at: starts, duration: Number(event.timeduration ?? 0), event_type: String(event.eventtype ?? ""),
      course_id: Number(course.id ?? event.courseid ?? 0), course_name: String(course.shortname ?? course.fullname ?? ""),
      location: String(event.location ?? ""),
      url: resolveUrl(baseUrl, String(event.url || `/calendar/view.php?view=day&time=${starts}`)),
    });
  }
  return [...events.values()];
}

// Only locate a calendar month. The event supplies the canonical timestamp, so
// translated wall-clock text is never interpreted in the machine's timezone.
export function calendarMonthOf(shown: string, language?: string): { year: number; month: number } | undefined {
  const text = shown.normalize("NFKC").toLowerCase();
  const iso = /^(\d{4})-(\d{2})-\d{2}/u.exec(text);
  if (iso && Number(iso[2]) >= 1 && Number(iso[2]) <= 12) return { year: Number(iso[1]), month: Number(iso[2]) };
  const years = [...text.matchAll(/(?<!\d)[1-9]\d{3}(?!\d)/gu)];
  if (!language || years.length !== 1) return undefined;
  const locale = language.replaceAll("_", "-");
  try {
    if (!Intl.DateTimeFormat.supportedLocalesOf(locale).length) return undefined;
    const matches = new Set<number>();
    const formatters = (["long", "short"] as const).flatMap(month => ([undefined, "numeric"] as const).map(day =>
      new Intl.DateTimeFormat(locale, { month, day, calendar: "gregory", timeZone: "UTC" })));
    for (let month = 1; month <= 12; month++) {
      for (const formatter of formatters) {
        const date = new Date(Date.UTC(2026, month - 1, 15));
        const token = formatter.resolvedOptions().day
          ? formatter.formatToParts(date).find(part => part.type === "month")?.value
          : formatter.format(date);
        const name = token?.normalize("NFKC").toLowerCase();
        if (!name || /^\p{N}+$/u.test(name)) continue;
        const index = text.indexOf(name);
        // CJK month tokens include a suffix such as 月; adjoining year/day text is valid.
        const numeric = /^\p{N}/u.test(name);
        const before = text.slice(0, index);
        const after = text.slice(index + name.length);
        if (index >= 0 && !(numeric ? /\p{N}$/u : /[\p{L}\p{N}]$/u).test(before)
          && (numeric || !/^[\p{L}\p{N}]/u.test(after))) matches.add(month);
      }
    }
    if (matches.size === 1) return { year: Number(years[0][0]), month: [...matches][0] };
  } catch { /* Unsupported Moodle language variants leave the date unknown. */ }
  return undefined;
}

export function calendarIcs(events: CalendarEvent[], baseUrl: string): string {
  const stamp = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const escape = (value: string) => value.replaceAll("\\", "\\\\").replace(/\r\n|\r|\n/gu, "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//moodle-cli//Calendar//EN", "CALSCALE:GREGORIAN"];
  const now = stamp(Date.now() / 1000);
  const encoder = new TextEncoder();
  for (const e of events) lines.push("BEGIN:VEVENT", `UID:${e.id}@${new URL(baseUrl).host}`, `DTSTAMP:${now}`, `DTSTART:${stamp(e.starts_at)}`, ...(e.duration ? [`DTEND:${stamp(e.starts_at + e.duration)}`] : []), `SUMMARY:${escape(e.name)}`, `DESCRIPTION:${escape(e.description)}`, `LOCATION:${escape(e.location)}`, `URL:${escape(e.url)}`, "END:VEVENT");
  lines.push("END:VCALENDAR");
  // RFC 5545 folds at 75 octets, without splitting a UTF-8 character.
  return lines.map(line => {
    let folded = "", bytes = 0;
    for (const char of line) {
      const size = encoder.encode(char).length;
      if (bytes + size > 75) { folded += "\r\n "; bytes = 1; }
      folded += char; bytes += size;
    }
    return folded;
  }).join("\r\n") + "\r\n";
}
