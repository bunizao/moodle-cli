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
// The words alone, so "Week 9 - Mini Test" is exactly what someone typing "week 9 mini test" meant.
const words = (value: string): string => normalize(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
  const labels = sectionLabels(sections);
  const label = (s: Section) => labels.get(s.id) ?? s.name;
  const numbers = raw.match(/\b\d+\b/gu) ?? [];
  let matches = sections.filter(s => numbers.length === 1
    ? (label(s).match(/\b\d+\b/gu) ?? []).some(n => Number(n) === Number(numbers[0]))
      // Words beside the number must name the section too: "assignment 2" is not week 2.
      && (raw === numbers[0] || tokensMatch(label(s), raw))
    : normalize(label(s)).includes(raw));
  // Narrow by the section's own name: "week 5" is the week rather than the week's
  // children, whose labels carry it too, and "week 5 real-time" is that week's child.
  const named = matches.filter(s => tokensMatch(s.name, raw));
  if (matches.length > 1 && named.length) matches = named;
  if (matches.length === 1) return { section: matches[0] };
  if (matches.length > 1) throw new ReferenceError("ambiguous", `Several sections match '${ref}'.`, matches.map(s => ({ id: s.id, name: label(s) })));
  if (/^\d+$/u.test(raw)) {
    const positional = sections.filter(s => s.section === Number(raw));
    if (positional.length === 1) return { section: positional[0], positional: true };
  }
  throw new ReferenceError("not_found", `No section matches '${ref}'.`, sections.map(s => ({ id: s.id, name: s.name })));
}

// Only the site's own marker is authoritative, and without one there is no answer.
// Every other signal was tried against real courses and named the wrong week: start
// dates are enrolment dates, unfinished work points at week 1, and completions,
// recent visits and deadlines cluster in assessment sections.
export function currentSection(sections: readonly Section[]): Section | undefined {
  const marked = sections.filter(s => s.current);
  return marked.length === 1 ? marked[0] : undefined;
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
    if (tokensMatch(s.name, query)) rows.push({ ...context, id: s.id, name: s.name, type: "section", score: words(s.name) === words(query) ? 100 : 70 });
    for (const a of s.activities) {
      if (!tokensMatch(`${a.name} ${label}`, query)) continue;
      const chrome = ["label", "cms"].includes(a.modname);
      const score = chrome ? 1 : words(a.name) === words(query) ? 100 : tokensMatch(a.name, query) ? 80 : 60;
      rows.push({ ...context, id: a.id, name: a.name, type: a.modname, score, activity: a });
    }
  }
  const useful = rows.filter(r => r.score > 1);
  return (useful.length ? useful : rows).sort((a, b) => b.score - a.score || a.id - b.id);
}

// Which section each nested one folds into. Only the innermost level folds: a section
// holding sections that hold sections (a tab of weeks) is a heading, and its children
// stay at the top level. Without parent ids from the site, a nested format still shows
// in the flat list as child names ("Own time") repeating after each parent.
function parentsOf(sections: readonly Section[]): Map<number, Section> {
  const byId = new Map(sections.map(s => [s.id, s]));
  const parents = new Map<number, Section>();
  if (sections.some(s => s.parent !== undefined)) {
    const holders = new Set(sections.map(s => s.parent));
    const headings = new Set(sections.filter(s => holders.has(s.id)).map(s => s.parent));
    for (const s of sections) {
      const parent = s.parent === undefined || headings.has(s.parent) ? undefined : byId.get(s.parent);
      if (parent) parents.set(s.id, parent);
    }
    return parents;
  }
  const counts = new Map<string, number>();
  for (const s of sections) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  let last: Section | undefined;
  for (const s of sections) {
    if ((counts.get(s.name) ?? 0) < 2) last = s;
    else if (last) parents.set(s.id, last);
  }
  return parents;
}

// A child's own name ("Own time") says nothing on its own, so its label carries the parent.
export function sectionLabels(sections: readonly Section[]): Map<number, string> {
  const parents = parentsOf(sections);
  const name = (s: Section) => s.name || `Section ${s.section}`;
  return new Map(sections.map(s => {
    const parent = parents.get(s.id);
    return [s.id, parent ? `${name(parent)} › ${name(s)}` : name(s)];
  }));
}

// What the course page shows at the top level, each entry with the child sections it
// renders inside it.
export function sectionTree(sections: readonly Section[]): Array<{ section: Section; children: Section[] }> {
  const parents = parentsOf(sections);
  const tree = sections.filter(s => !parents.has(s.id)).map(section => ({ section, children: [] as Section[] }));
  const nodes = new Map(tree.map(node => [node.section.id, node]));
  // A child the site lists before its parent still lands inside it.
  for (const s of sections) nodes.get(parents.get(s.id)?.id ?? NaN)?.children.push(s);
  return tree;
}

// Choosing a parent means its children too, as on the page.
export function withChildSections(section: Section, sections: readonly Section[]): Section[] {
  const node = sectionTree(sections).find(n => n.section.id === section.id);
  return node ? [node.section, ...node.children] : [section];
}

export function splitUnitPhrase(phrase: string, courses: readonly Course[]): { course: Course; query: string } | undefined {
  const words = phrase.trim().split(/\s+/u);
  for (let count = words.length; count > 0; count--) {
    try { return { course: resolveUnit(words.slice(0, count).join(" "), courses), query: words.slice(count).join(" ") }; }
    catch (error) { if (!(error instanceof ReferenceError) || error.code === "ambiguous") throw error; }
  }
  return undefined;
}
