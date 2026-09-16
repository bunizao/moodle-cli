import { describe, expect, it } from "vitest";
import { currentSection, resolveSection, resolveUnit, searchSections, splitUnitPhrase } from "../src/resolve.js";
import type { Course, Section } from "../src/models.js";

export const fixtureUnits: Course[] = [
  { id: 1, shortname: "DB240", fullname: "Databases", startdate: 1788134400, category: 0, visible: true },
  { id: 2, shortname: "algo-2", fullname: "Algorithms", startdate: 1788134400, category: 0, visible: true },
  { id: 3, shortname: "STATS", fullname: "Statistics", startdate: 1788134400, category: 0, visible: true },
  { id: 4, shortname: "", fullname: "Ethics in Computing", startdate: 1788134400, category: 0, visible: true },
];
export function fixtureSections(label = "Week"): Section[] {
  return [7, 17].map((number, index) => ({ id: 70 + index, section: index + 1, name: `${label} ${number}`, visible: true, summary: "", current: index === 0, activities: [
    { id: 100 + index * 10, name: `${label} ${number} Lecture slides`, modname: "resource", description: "", url: `https://moodle.example.edu/mod/resource/view.php?id=${100 + index * 10}`, visible: true },
    { id: 101 + index * 10, name: "Mini Test", modname: "assign", description: "", url: "", visible: true },
    { id: 102 + index * 10, name: "Lecture slides", modname: "label", description: "", url: "", visible: true },
  ] }));
}

describe("site vocabulary resolution", () => {
  it.each(fixtureUnits)("resolves $fullname without a code pattern", c => {
    expect(resolveUnit(c.shortname || c.fullname, fixtureUnits).id).toBe(c.id);
    expect(resolveUnit(c.fullname.toLowerCase(), fixtureUnits).id).toBe(c.id);
  });
  it("uses exact names before substring, then id and URL", () => {
    expect(resolveUnit("Computing", [...fixtureUnits, { ...fixtureUnits[0], id: 5, fullname: "Computing" }]).id).toBe(5);
    expect(resolveUnit("Ethics", fixtureUnits).id).toBe(4);
    expect(resolveUnit(2, fixtureUnits).id).toBe(2);
    expect(resolveUnit("https://moodle.example.edu/course/view.php?id=2", fixtureUnits).id).toBe(2);
    expect(() => resolveUnit("missing", fixtureUnits)).toThrow("Your units: DB240, algo-2, STATS, Ethics in Computing");
  });
  it.each(["Week", "Topic", "Semana"])("resolves %s 7 without matching 17", label => {
    expect(resolveSection(7, fixtureSections(label)).section.id).toBe(70);
    expect(resolveSection(`${label} 7`, fixtureSections(label)).section.id).toBe(70);
  });
  it("reports positional selection and refuses ambiguous section numbers", () => {
    expect(resolveSection(2, fixtureSections())).toMatchObject({ section: { id: 71 }, positional: true });
    expect(() => resolveSection(7, [...fixtureSections(), { ...fixtureSections()[0], id: 999 }])).toThrow("Several sections");
  });
  it("ranks a resource before labels and preserves both matching tasks", () => {
    expect(searchSections(fixtureUnits[1], fixtureSections(), "week 7 slides").map(r => r.id)).toEqual([100]);
    expect(searchSections(fixtureUnits[1], fixtureSections(), "mini test").map(r => r.id)).toEqual([101, 111]);
    expect(splitUnitPhrase("Ethics in Computing week 7 slides", fixtureUnits)).toMatchObject({ course: { id: 4 }, query: "week 7 slides" });
  });
  it("uses the site marker, never week arithmetic, and tags an unfinished guess", () => {
    expect(currentSection(fixtureSections())?.section.id).toBe(70);
    const unmarked = fixtureSections().map(s => ({ ...s, current: false }));
    // A course start date is often the enrolment date, so it must not pick a section.
    expect(currentSection(unmarked)).toBeUndefined();
    const unfinished = unmarked.map((s, index) => index === 1 ? { ...s, activities: s.activities.map(a => ({ ...a, completion: 0 })) } : s);
    expect(currentSection(unfinished)).toMatchObject({ section: { id: unfinished[1].id }, estimated: true });
  });
});
