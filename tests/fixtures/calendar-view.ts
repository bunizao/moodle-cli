import { readFileSync } from "node:fs";

const monthHtml = readFileSync(new URL("./moodle-5.0/calendar-month.html", import.meta.url), "utf8");

// Stock month-view attributes and navigation; timestamps use Gregorian UTC here
// so tests can exercise arbitrary windows without hardcoding the current month.
export function calendarMonthHtml(time = Math.floor(Date.now() / 1000)): string {
  const date = new Date(time * 1000);
  return monthHtml.replace(/data-year="\d+"/u, `data-year="${date.getUTCFullYear()}"`).replace(/data-month="\d+"/u, `data-month="${date.getUTCMonth() + 1}"`);
}

export function calendarMonthData(data: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const next = new Date(Date.UTC(Number(args.year), Number(args.month), 1));
  return { ...data, nextperiod: data.nextperiod ?? { year: next.getUTCFullYear(), mon: next.getUTCMonth() + 1, timestamp: next.getTime() / 1000 } };
}
