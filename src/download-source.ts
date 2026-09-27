import { BACK, type Ui } from "@bunizao/cli-kit";

import type { MoodleClient } from "./client.js";
import { DOWNLOADABLE_TYPES, downloadableActivities, sectionPage } from "./download.js";
import { CliError, UsageError } from "./errors.js";
import type { IntentService } from "./intents.js";
import type { Course, Section } from "./models.js";
import { ReferenceError, resolveUnit, sectionLabels, sectionTree } from "./resolve.js";

const KINDS: Record<string, string> = { resource: "file", folder: "folder", assign: "assignment" };

// Turns what a person typed, or nothing at all, into a source downloadMoodleFiles
// understands: an activity id, or a section or file URL. With a terminal it walks the
// same path as the web page (unit, then section, then item) and Escape steps back;
// without one it errors with the choices instead of prompting.
export async function chooseDownloadSource(client: MoodleClient, service: IntentService, ref: string, ui?: Ui): Promise<string> {
  const raw = ref.trim();
  if (/^\d+$/u.test(raw) || raw.includes("://")) return raw;

  const courses = await client.getCourses();
  if (!raw) {
    if (!ui) throw new UsageError("Name what to download.", "Pass an activity ID, a Moodle URL, or a phrase such as 'UNIT week 3'.");
    return browse(client, service, courses, ui);
  }

  const parsed = await unitAndQuery(raw, courses, ui);
  if (parsed && !parsed.query) {
    if (!ui) throw new UsageError(`Name a section or item in ${unitName(parsed.course)}.`, `Try 'moodle dl "${raw} week 3"' or 'moodle find "*" ${raw}'.`);
    return browse(client, service, courses, ui, parsed.course);
  }

  const rows = await service.find(parsed?.query ?? raw, parsed?.course.id, [...DOWNLOADABLE_TYPES, "section"], false);
  // A query that matches a section's own name ("UNIT week 3") means the whole section,
  // the way the web page groups it; the items inside it matching too is expected.
  const sectionRows = rows.filter(r => r.type === "section");
  const items = rows.filter(r => r.type !== "section");
  if (sectionRows.length === 1) return sectionUrl(client, sectionRows[0].unit_id, await sectionOf(service, sectionRows[0]));
  if (!sectionRows.length && items.length === 1) return String(items[0].id);
  if (!rows.length) throw new ReferenceError("not_found", `Nothing downloadable matches '${raw}'.`, []);
  if (!ui) throw new ReferenceError("ambiguous", `Several items match '${raw}'.`, rows.map(({ id, name, type, unit_code }) => ({ id, name, type, code: unit_code })));
  const choices = await Promise.all(rows.map(async r => ({
    value: r.type === "section" ? sectionUrl(client, r.unit_id, await sectionOf(service, r)) : String(r.id),
    label: r.type === "section" ? `Everything in ${r.section}` : r.name,
    hint: [r.unit_code, r.type === "section" ? "section" : `${r.section} · ${KINDS[r.type ?? ""] ?? r.type}`].filter(Boolean).join(" · "),
  })));
  return ui.select(`Several items match '${raw}'`, choices, { search: true });
}

// "UNIT week 5" splits into the unit and the rest. When the leading words name several
// units ("fit week 5"), a terminal asks which one instead of failing.
async function unitAndQuery(raw: string, courses: readonly Course[], ui?: Ui): Promise<{ course: Course; query: string } | undefined> {
  const words = raw.split(/\s+/u);
  for (let count = words.length; count > 0; count--) {
    const prefix = words.slice(0, count).join(" ");
    const query = words.slice(count).join(" ");
    try {
      return { course: resolveUnit(prefix, courses), query };
    } catch (error) {
      if (!(error instanceof ReferenceError)) throw error;
      if (error.code === "ambiguous") {
        if (!ui) throw error;
        const ids = new Set(error.candidates.map(c => c.id));
        return { course: await pickUnit(ui, courses.filter(c => ids.has(c.id)), `'${prefix}' matches several units`), query };
      }
    }
  }
  return undefined;
}

// Unit, then section, then item, like the web page. Escape on a list returns to the one
// before it with the previous choice still highlighted; a section with nothing to save
// says so and stays on the section list.
async function browse(client: MoodleClient, service: IntentService, courses: readonly Course[], ui: Ui, start?: Course): Promise<string> {
  let course = start;
  let left: Course | undefined;
  let sectionId: number | undefined;
  for (;;) {
    course ??= await pickUnit(ui, courses, "Unit", left);
    const sections = await service.sections(course.id);
    const labels = sectionLabels(sections);
    const counts = itemCounts(sections);
    const listed = sections.filter(s => counts.get(s.id));
    if (!listed.length) {
      if (courses.length < 2) throw new ReferenceError("not_found", `${unitName(course)} has nothing to download.`, []);
      ui.warn(`${unitName(course)} has nothing to download.`);
      course = undefined;
      continue;
    }
    const initial = sectionId ?? listed.find(s => s.current)?.id;
    const picked = await ui.select(`${unitName(course)} › Section`, listed.map(s => ({
      value: s.id,
      label: labels.get(s.id)!,
      // No counts here: the filter searches hints, and "week 5" must not find "5 items".
      ...(s.current ? { hint: "current" } : {}),
    })), { search: true, back: true, ...(initial !== undefined ? { initial } : {}) });
    if (picked === BACK) {
      left = course;
      course = undefined;
      sectionId = undefined;
      continue;
    }
    sectionId = picked;
    const chosen = listed.find(s => s.id === picked)!;
    const label = labels.get(chosen.id)!;
    // The section's page, not the flat list, says what it holds; some formats nest sections.
    const items = await sectionPage(client, course.id, chosen.section).then(downloadableActivities, (error: unknown) => {
      if (error instanceof CliError && error.code === "not_found") return [];
      throw error;
    });
    if (!items.length) {
      ui.warn(`${label} has no files to download.`);
      continue;
    }
    const item = await ui.select(`${unitName(course)} › ${label}`, [
      ...(items.length > 1 ? [{ value: sectionUrl(client, course.id, chosen), label: `Everything in ${label}`, hint: plural(items.length, "item") }] : []),
      ...items.map(a => ({ value: String(a.id), label: a.name, hint: KINDS[a.modname] ?? a.modname })),
    ], { search: true, back: true });
    if (item !== BACK) return item;
  }
}

// What the flat list puts under each top-level section, counting the child sections a
// nested format renders inside it. The page itself is only read once chosen.
function itemCounts(sections: readonly Section[]): Map<number, number> {
  return new Map(sectionTree(sections).map(({ section, children }) =>
    [section.id, [section, ...children].reduce((n, s) => n + downloadableActivities(s).length, 0)]));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function pickUnit(ui: Ui, courses: readonly Course[], message: string, initial?: Course): Promise<Course> {
  return ui.select(message, courses.map(c => ({
    value: c,
    label: c.fullname || c.shortname,
    ...(c.shortname && c.shortname !== c.fullname ? { hint: c.shortname } : {}),
  })), { search: true, ...(initial ? { initial } : {}) });
}

async function sectionOf(service: IntentService, row: { unit_id: number; section_id: number }): Promise<Section> {
  return (await service.sections(row.unit_id)).find(s => s.id === row.section_id)!;
}

function unitName(course: Course): string {
  return course.shortname || course.fullname;
}

function sectionUrl(client: MoodleClient, courseId: number, section: Section): string {
  return `${client.baseUrl.replace(/\/$/u, "")}/course/view.php?id=${courseId}&section=${section.section}`;
}
