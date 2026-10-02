import { describe, expect, it } from "vitest";
import { currentSection, resolveSection, resolveUnit, searchSections, sectionLabels, sectionTree, splitUnitPhrase, tokensMatch, withChildSections } from "../src/resolve.js";
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
  it("finds items in a nested child section through its parent's name", () => {
    const child = (id: number, parent: number): Section => ({ id, section: id, name: "Own time", visible: true, summary: "", activities: [
      { id: id * 10, name: "Lecture slides", modname: "resource", description: "", url: "", visible: true },
    ] });
    const nested = [{ ...fixtureSections()[0], activities: [] }, child(2, 7), { ...fixtureSections()[1], activities: [] }, child(4, 17)];
    const rows = searchSections(fixtureUnits[1], nested, "week 7 slides");
    expect(rows.map(r => [r.id, r.section])).toEqual([[20, "Week 7 › Own time"]]);
    expect(searchSections(fixtureUnits[1], nested, "week 7").filter(r => r.type === "section").map(r => r.id)).toEqual([70]);
  });
  it("prefers the week over a numbered assessment and reaches nested children through the parent", () => {
    const child = (id: number, name: string): Section => ({ id, section: id, name, visible: true, summary: "", activities: [] });
    const [week7, week17] = fixtureSections();
    const nested = [week7, child(2, "Own time"), child(3, "Real time"), week17, child(5, "Own time"), child(6, "Real time"), child(8, "7. Written")];
    expect(resolveSection("week 7", nested).section.id).toBe(70);
    expect(resolveSection("week 7 real time", nested).section.id).toBe(3);
    // A bare number is honestly ambiguous; a repeated child name lists its parents.
    expect(() => resolveSection(7, nested)).toThrow(expect.objectContaining({ candidates: [{ id: 70, name: "Week 7" }, { id: 8, name: "7. Written" }] }));
    expect(() => resolveSection("own time", nested)).toThrow(expect.objectContaining({ candidates: [{ id: 2, name: "Week 7 › Own time" }, { id: 5, name: "Week 17 › Own time" }] }));
    // Words beside the number must name the section, so an item phrase falls through to items.
    expect(() => resolveSection("assignment 7", nested)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(resolveSection("7 written", nested).section.id).toBe(8);
    expect(withChildSections(week7, nested).map(s => s.id)).toEqual([70, 2, 3]);
    expect(withChildSections(week17, nested).map(s => s.id)).toEqual([71, 5, 6]);
  });
  it("folds only the innermost level when the site gives parent ids", () => {
    const at = (id: number, name: string, parent?: number): Section => ({ id, section: id, name, visible: true, summary: "", ...(parent ? { parent } : {}), activities: [] });
    // A tab of weeks holds sections that hold sections, so it stays a heading.
    const sections = [at(1, "Learning"), at(2, "Getting started", 1), at(3, "Week 7", 1), at(4, "Own time", 3), at(5, "Assessments"), at(6, "1. Written", 5), at(7, "2. Written", 5)];
    expect([...sectionLabels(sections).values()]).toEqual(["Learning", "Getting started", "Week 7", "Week 7 › Own time", "Assessments", "Assessments › 1. Written", "Assessments › 2. Written"]);
    expect(sectionTree(sections).map(n => [n.section.id, n.children.map(c => c.id)])).toEqual([[1, []], [2, []], [3, [4]], [5, [6, 7]]]);
    expect(resolveSection("2. written", sections).section.id).toBe(7);
    // A child listed ahead of its parent still belongs to it.
    const [learning, started, week, own] = sections;
    expect(withChildSections(week, [own, learning, started, week]).map(s => s.id)).toEqual([3, 4]);
  });
  it("uses the site marker and never guesses without one", () => {
    expect(currentSection(fixtureSections())?.id).toBe(70);
    const unmarked = fixtureSections().map(s => ({ ...s, current: false }));
    expect(currentSection(unmarked)).toBeUndefined();
    // Unfinished work used to stand in for the marker and named week 1 in week 9.
    const unfinished = unmarked.map((s, index) => index === 1 ? { ...s, activities: s.activities.map(a => ({ ...a, completion: 0 })) } : s);
    expect(currentSection(unfinished)).toBeUndefined();
  });
  it("matches letter-and-number shorthand against numbered names", () => {
    expect(tokensMatch("Assignment 2 (Weight: 20%)", "a2")).toBe(true);
    expect(tokensMatch("Week 07: Regression", "w7")).toBe(true);
    expect(tokensMatch("Assignment 12", "a2")).toBe(false);
    expect(tokensMatch("Lab 2", "a2")).toBe(false);
    expect(tokensMatch("Week 7", "07")).toBe(true);
  });
});
