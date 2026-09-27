import type { Ui } from "@bunizao/cli-kit";

import type { MoodleClient } from "./client.js";
import { DOWNLOADABLE_TYPES, downloadableActivities, sectionPage } from "./download.js";
import { UsageError } from "./errors.js";
import type { IntentService } from "./intents.js";
import type { Course, Section } from "./models.js";
import { ReferenceError, splitUnitPhrase } from "./resolve.js";

// Turns what a person typed, or nothing at all, into a source downloadMoodleFiles
// understands: an activity id, or a section or file URL. With a terminal it walks the
// same path as the web page (unit, then section, then item); without one it errors
// with the choices instead of prompting.
export async function chooseDownloadSource(client: MoodleClient, service: IntentService, ref: string, ui?: Ui): Promise<string> {
  const raw = ref.trim();
  if (/^\d+$/u.test(raw) || raw.includes("://")) return raw;

  const courses = await client.getCourses();
  if (!raw) {
    if (!ui) throw new UsageError("Name what to download.", "Pass an activity ID, a Moodle URL, or a phrase such as 'UNIT week 3'.");
    const courseId = await ui.select("Unit", courses.map(c => ({ value: c.id, label: c.fullname || c.shortname, ...(c.shortname ? { hint: c.shortname } : {}) })));
    return browseUnit(client, courses.find(c => c.id === courseId)!, await service.sections(courseId), ui);
  }

  const parsed = splitUnitPhrase(raw, courses);
  if (parsed && !parsed.query) {
    const sections = await service.sections(parsed.course.id);
    if (!ui) throw new UsageError(`Name a section or item in ${parsed.course.shortname || parsed.course.fullname}.`, `Try 'moodle dl "${raw} week 3"' or 'moodle find "*" ${raw}'.`);
    return browseUnit(client, parsed.course, sections, ui);
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
    label: r.type === "section" ? `Everything in ${r.name}` : r.name,
    hint: [r.unit_code, r.type === "section" ? "section" : `${r.section} · ${r.type}`].filter(Boolean).join(" · "),
  })));
  return ui.select(`Several items match '${raw}'`, choices);
}

async function sectionOf(service: IntentService, row: { unit_id: number; id: number }): Promise<Section> {
  return (await service.sections(row.unit_id)).find(s => s.id === row.id)!;
}

async function browseUnit(client: MoodleClient, course: Course, sections: readonly Section[], ui: Ui): Promise<string> {
  const labels = sectionLabels(sections);
  const withContent = sections.filter(s => s.activities.some(a => a.modname !== "label"));
  if (!withContent.length) throw new ReferenceError("not_found", `${course.shortname || course.fullname} has nothing to download.`, []);
  const sectionId = await ui.select("Section", withContent.map(s => ({ value: s.id, label: labels.get(s.id)!, ...(s.current ? { hint: "current" } : {}) })));
  const chosen = withContent.find(s => s.id === sectionId)!;
  // The section's page, not the flat list, says what it holds; some formats nest sections.
  const items = downloadableActivities(await sectionPage(client, course.id, chosen.section));
  if (!items.length) throw new ReferenceError("not_found", `${labels.get(chosen.id)} has nothing to download.`, []);
  if (items.length === 1) return String(items[0].id);
  return ui.select("Download", [
    { value: sectionUrl(client, course.id, chosen), label: "Everything in this section", hint: `${items.length} items` },
    ...items.map(a => ({ value: String(a.id), label: a.name, hint: a.modname })),
  ]);
}

// Formats that nest sections ("Week 5" holding "Own-time", "Real-time") flatten into a
// list where the child names repeat; the nearest uniquely named section before a
// repeated one is the only context left, so the label carries it.
function sectionLabels(sections: readonly Section[]): Map<number, string> {
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

function sectionUrl(client: MoodleClient, courseId: number, section: Section): string {
  return `${client.baseUrl.replace(/\/$/u, "")}/course/view.php?id=${courseId}&section=${section.section}`;
}
