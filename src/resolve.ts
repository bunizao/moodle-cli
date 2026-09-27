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
export const tokensMatch = (text: string, query: string): boolean => normalize(query).split(" ").every(token => tokenMatches(normalize(text), token));

function tokenMatches(text: string, token: string): boolean {
  if (/^\d+$/u.test(token)) return (text.match(/\b\d+\b/gu) ?? []).some(n => Number(n) === Number(token));
  if (text.includes(token)) return true;
  // Shorthand people type for numbered items: "a2" for "Assignment 2", "w7" for "Week 7".
  const short = /^(\p{L}+)(\d+)$/u.exec(token);
  return short !== null && new RegExp(`(?:^|[^\\p{L}])${short[1]}\\p{L}*[\\s:.#-]*0*${Number(short[2])}(?!\\d)`, "u").test(text);
}

export function resolveUnit(value: string | number, courses: readonly Course[]): Course {
  if (typeof value === "number") { const byId = courses.find(c => c.id === value); if (byId) return byId; throw unitError("not_found", value, courses); }
  const raw = normalize(String(value));
  const exact = courses.filter(c => [c.shortname, c.fullname].some(name => normalize(name) === raw));
  const matches = exact.length ? exact : courses.filter(c => [c.shortname, c.fullname].some(name => normalize(name).includes(raw)));
  if (raw && matches.length === 1) return matches[0];

  let id = /^\d+$/u.test(raw) ? Number(raw) : undefined;
  try {
    const url = new URL(String(value));
    if (url.pathname.endsWith("/course/view.php")) id = Number(url.searchParams.get("id"));
  } catch { /* Names are not URLs. */ }
  const course = courses.find(c => c.id === id);
  if (course) return course;
  if (raw && matches.length > 1) throw unitError("ambiguous", value, matches);
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

// Only the site's own marker is authoritative. Course start dates are enrolment
// open dates on many sites, so counting weeks from them names the wrong section;
// unfinished work is the one remaining signal and is reported as a guess.
export function currentSection(sections: readonly Section[]): { section: Section; estimated?: boolean } | undefined {
  const marked = sections.filter(s => s.current);
  if (marked.length > 1) return undefined;
  if (marked.length === 1) return { section: marked[0] };
  const unfinished = sections.find(s => s.activities.some(a => a.completion === 0));
  return unfinished ? { section: unfinished, estimated: true } : undefined;
}

export interface SearchMatch extends Candidate { unit_id: number; unit_code: string; section_id: number; section: string; score: number; activity?: Activity }
export function searchSections(course: Course, sections: readonly Section[], query: string): SearchMatch[] {
  const rows: SearchMatch[] = [];
  const labels = sectionLabels(sections);
  for (const s of sections) {
    const label = labels.get(s.id) ?? s.name;
    const context = { unit_id: course.id, unit_code: course.shortname || course.fullname, section_id: s.id, section: label };
    // A section matches on its own name; its items also match on the parent in the label,
    // so "week 5 slides" finds slides in a nested "Week 5 › Own-time".
    if (tokensMatch(s.name, query)) rows.push({ ...context, id: s.id, name: s.name, type: "section", score: normalize(s.name) === normalize(query) ? 100 : 70 });
    for (const a of s.activities) {
      if (!tokensMatch(`${a.name} ${label}`, query)) continue;
      const chrome = ["label", "cms"].includes(a.modname);
      const score = chrome ? 1 : normalize(a.name) === normalize(query) ? 100 : tokensMatch(a.name, query) ? 80 : 60;
      rows.push({ ...context, id: a.id, name: a.name, type: a.modname, score, activity: a });
    }
  }
  const useful = rows.filter(r => r.score > 1);
  return (useful.length ? useful : rows).sort((a, b) => b.score - a.score || a.id - b.id);
}

// Formats that nest sections ("Week 5" holding "Own-time", "Real-time") flatten into a
// list where the child names repeat; the nearest uniquely named section before a
// repeated one is the only context left, so the label carries it.
export function sectionLabels(sections: readonly Section[]): Map<number, string> {
  const counts = new Map<string, number>();
  for (const s of sections) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  const labels = new Map<number, string>();
  let parent = "";
  for (const s of sections) {
    const name = s.name || `Section ${s.section}`;
    if ((counts.get(s.name) ?? 0) > 1 && parent) labels.set(s.id, `${parent} › ${name}`);
    else {
      labels.set(s.id, name);
      parent = name;
    }
  }
  return labels;
}

export function splitUnitPhrase(phrase: string, courses: readonly Course[]): { course: Course; query: string } | undefined {
  const words = phrase.trim().split(/\s+/u);
  for (let count = words.length; count > 0; count--) {
    try { return { course: resolveUnit(words.slice(0, count).join(" "), courses), query: words.slice(count).join(" ") }; }
    catch (error) { if (!(error instanceof ReferenceError) || error.code === "ambiguous") throw error; }
  }
  return undefined;
}
