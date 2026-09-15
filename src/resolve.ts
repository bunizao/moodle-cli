import type { Activity, Course, Section } from "./models.js";

export interface Candidate { id: number; name: string; code?: string; type?: string }

export class ReferenceError extends Error {
  readonly hint = "Run `moodle units` to see this site's names, or refine the reference.";
  constructor(readonly code: "ambiguous" | "not_found", message: string, readonly candidates: Candidate[]) {
    super(message);
    this.name = "ReferenceError";
  }
}

export const normalize = (value: string): string => value.normalize("NFKC").toLocaleLowerCase().trim().replace(/\s+/gu, " ");
export const tokensMatch = (text: string, query: string): boolean => normalize(query).split(" ").every(token => (/^\d+$/u.test(token) ? (normalize(text).match(/\b\d+\b/gu) ?? []).some(n => n === token) : normalize(text).includes(token)));

export function resolveUnit(value: string | number, courses: readonly Course[]): Course {
  if (typeof value === "number") { const byId = courses.find(c => c.id === value); if (byId) return byId; throw unitError("not_found", value, courses); }
  const raw = normalize(String(value));
  const exact = courses.filter(c => [c.shortname, c.fullname].some(name => normalize(name) === raw));
  const matches = exact.length ? exact : courses.filter(c => [c.shortname, c.fullname].some(name => normalize(name).includes(raw)));
  if (raw && matches.length === 1) return matches[0];
  if (raw && matches.length > 1) throw unitError("ambiguous", value, matches);
  let id = /^\d+$/u.test(raw) ? Number(raw) : undefined;
  try {
    const url = new URL(String(value));
    if (url.pathname.endsWith("/course/view.php")) id = Number(url.searchParams.get("id"));
  } catch { /* Names are not URLs. */ }
  const course = courses.find(c => c.id === id);
  if (course) return course;
  throw unitError("not_found", value, courses);
}

function unitError(code: "ambiguous" | "not_found", ref: string | number, courses: readonly Course[]): ReferenceError {
  const candidates = courses.map(c => ({ id: c.id, name: c.fullname || c.shortname, code: c.shortname || undefined }));
  return new ReferenceError(code, `${code === "ambiguous" ? "Several units match" : "No unit matches"} '${ref}'. Your units: ${courses.map(c => c.shortname || c.fullname).join(", ")}.`, candidates);
}

export function resolveSection(ref: string | number, sections: readonly Section[]): { section: Section; positional?: boolean } {
  const raw = normalize(String(ref));
  const numbers = raw.match(/\b\d+\b/gu) ?? [];
  const matches = sections.filter(s => numbers.length === 1
    ? (s.name.match(/\b\d+\b/gu) ?? []).some(n => Number(n) === Number(numbers[0]))
    : normalize(s.name).includes(raw));
  if (matches.length === 1) return { section: matches[0] };
  if (matches.length > 1) throw new ReferenceError("ambiguous", `Several sections match '${ref}'.`, matches.map(s => ({ id: s.id, name: s.name })));
  if (/^\d+$/u.test(raw)) {
    const positional = sections.filter(s => s.section === Number(raw));
    if (positional.length === 1) return { section: positional[0], positional: true };
  }
  throw new ReferenceError("not_found", `No section matches '${ref}'.`, sections.map(s => ({ id: s.id, name: s.name })));
}

export function currentSection(course: Course, sections: readonly Section[], now = Date.now()): { section: Section; estimated?: boolean; start_at?: number; end_at?: number } | undefined {
  const marked = sections.filter(s => s.current);
  if (marked.length > 1) return undefined;
  const elapsed = Math.floor(now / 1000) - course.startdate;
  const week = Math.floor(elapsed / 604800) + 1;
  const range = course.startdate > 0 && elapsed >= 0 ? { start_at: course.startdate + (week - 1) * 604800, end_at: course.startdate + week * 604800 - 1 } : {};
  if (marked.length === 1) return { section: marked[0], ...range };
  if (course.startdate > 0 && elapsed >= 0 && (!course.enddate || now / 1000 <= course.enddate)) {
    const matching = sections.filter(s => (s.name.match(/\b\d+\b/gu) ?? []).some(n => Number(n) === week));
    if (matching.length === 1) return { section: matching[0], estimated: true, ...range };
  }
  const unfinished = sections.find(s => s.activities.some(a => a.completion === 0));
  return unfinished ? { section: unfinished } : undefined;
}

export interface SearchMatch extends Candidate { unit_id: number; unit_code: string; section_id: number; section: string; score: number; activity?: Activity }
export function searchSections(course: Course, sections: readonly Section[], query: string): SearchMatch[] {
  const rows: SearchMatch[] = [];
  for (const s of sections) {
    const context = { unit_id: course.id, unit_code: course.shortname || course.fullname, section_id: s.id, section: s.name };
    if (tokensMatch(s.name, query)) rows.push({ ...context, id: s.id, name: s.name, type: "section", score: normalize(s.name) === normalize(query) ? 100 : 70 });
    for (const a of s.activities) {
      if (!tokensMatch(`${a.name} ${s.name}`, query)) continue;
      const chrome = ["label", "cms"].includes(a.modname);
      const score = chrome ? 1 : normalize(a.name) === normalize(query) ? 100 : tokensMatch(a.name, query) ? 80 : 60;
      rows.push({ ...context, id: a.id, name: a.name, type: a.modname, score, activity: a });
    }
  }
  const useful = rows.filter(r => r.score > 1);
  return (useful.length ? useful : rows).sort((a, b) => b.score - a.score || a.id - b.id);
}

export function splitUnitPhrase(phrase: string, courses: readonly Course[]): { course: Course; query: string } | undefined {
  const words = phrase.trim().split(/\s+/u);
  for (let count = words.length; count > 0; count--) {
    try { return { course: resolveUnit(words.slice(0, count).join(" "), courses), query: words.slice(count).join(" ") }; }
    catch (error) { if (!(error instanceof ReferenceError) || error.code === "ambiguous") throw error; }
  }
  return undefined;
}
