import { describe, expect, it, vi } from "vitest";
import { createIntentService } from "../src/intents.js";
import { createMoodleMcpServer, TOOL_CATALOG } from "../src/mcp/server.js";
import { hasGrade, pageGradeReports } from "../src/grades.js";
import { parseGradeItem } from "../src/parsers.js";
import { renderScreen } from "../src/screens.js";
import type { GradeItem } from "../src/models.js";
import { feedback, item, gradebook } from "./fixtures/gradebook.js";

async function mcp(args: Record<string, unknown>, gateway = gradebook()) {
  const response = await createMoodleMcpServer(gateway).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "grades", arguments: args } }, { protocolVersion: "2025-06-18" });
  return (response as { result: { structuredContent: Record<string, unknown>; content: { text: string }[]; isError?: boolean } }).result;
}

describe("bounded gradebook output", () => {
  it("summarizes a 45-item gradebook without copying rows, feedback or fetching deadlines", async () => {
    const gateway = gradebook();
    const profile = vi.spyOn(gateway, "getUser");
    const deadlines = vi.spyOn(gateway, "getOverview");
    const result = await createIntentService(gateway).run("grades", { unit: "algo-2" });
    expect(result).toEqual({ mode: "summary", total: 1, grades: [{ unit_id: 2, code: "algo-2", graded: 2, ungraded: 43, total: 45, total_grade: "78", total_range: "0–100", total_percentage: "78%" }] });
    expect(JSON.stringify(result).length).toBeLessThan(250);
    expect(profile).not.toHaveBeenCalled();
    expect(deadlines).not.toHaveBeenCalled();
    const screen = renderScreen(result);
    expect(screen).toContain("2 of 45 graded");
    expect(screen).toContain("Total  78 · 0–100 · 78%");
    expect(screen).not.toContain("Name");
  });
  it("keeps zero marks, excludes ungraded H5P rows and omits feedback by default", async () => {
    const gateway = gradebook();
    const deadlines = vi.spyOn(gateway, "getOverview");
    const profile = vi.spyOn(gateway, "getUser");
    const result = await mcp({ unit: "algo-2", mode: "graded" }, gateway);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ mode: "graded", matched: 2, returned: 2, has_more: false, grades: [{ graded: 2, total: 45, items: [{ id: 2044, type: "assign", grade: "0" }, { id: 2045, type: "quiz" }] }] });
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/feedback|Question/);
    expect(deadlines).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
  it("filters translated icon labels and normalizes assignment aliases", async () => {
    const args = { unit: "algo-2", mode: "all", types: [" Assignment "], include_feedback: true, limit: 1 };
    const result = await mcp(args);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ matched: 1, returned: 1, grades: [{ total: 1, graded: 1, ungraded: 0, total_grade: "78", items: [{ type: "assign", feedback }] }] });
    expect(result.structuredContent).toEqual(await createIntentService(gradebook()).run("grades", args));
    const summary = await createIntentService(gradebook()).run("grades", { unit: "algo-2", types: ["h5pactivity"] });
    expect(summary).toMatchObject({ grades: [{ graded: 0, ungraded: 43, total: 43 }] });
  });
  it("applies one default row budget across all units and pages after filtering", async () => {
    const result = await createIntentService(gradebook()).run("grades", { mode: "all" });
    const rows = (result.grades as { items?: GradeItem[] }[]).flatMap(g => g.items ?? []);
    expect(rows).toHaveLength(20);
    expect(result).toMatchObject({ total: 4, matched: 180, returned: 20, offset: 0, has_more: true });
    const page = await createIntentService(gradebook()).run("grades", { mode: "graded", types: ["quiz", "assign"], offset: 1, limit: 2 });
    expect(page).toMatchObject({ matched: 8, returned: 2, offset: 1, has_more: true });
    expect((page.grades as { items?: { id: number }[] }[]).flatMap(g => g.items ?? []).map(i => i.id)).toEqual([1045, 2044]);
    const end = await createIntentService(gradebook()).run("grades", { mode: "graded", offset: 8 });
    expect(end).toMatchObject({ matched: 8, returned: 0, has_more: false });
    expect((end.grades as object[]).every(g => !("items" in g))).toBe(true);
  });
  it("allows ungraded rows explicitly and retains the graded_only alias", async () => {
    const service = createIntentService(gradebook());
    const args = { unit: "algo-2", types: ["h5pactivity"], mode: "graded" };
    expect(await service.run("grades", args)).toMatchObject({ matched: 0, returned: 0, has_more: false });
    expect(await service.run("grades", { ...args, include_ungraded: true, limit: 1 })).toMatchObject({ matched: 43, returned: 1, has_more: true, grades: [{ items: [{ type: "h5pactivity", grade: "-" }] }] });
    expect(await service.run("grades", { unit: "algo-2", graded_only: true })).toEqual(await service.run("grades", { unit: "algo-2", mode: "graded" }));
  });
  it.each([{ mode: "detail" }, { limit: 0 }, { limit: 201 }, { offset: -1 }, { types: [" "] }])("rejects invalid selectors %j through MCP", async args => {
    const response = await createMoodleMcpServer(gradebook()).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "grades", arguments: args } }, { protocolVersion: "2025-06-18" });
    expect(response).toHaveProperty("error.code", -32602);
  });
  it("does not add tools, and classifies dash placeholders independently of numeric zero", () => {
    expect(TOOL_CATALOG.filter(t => t.name === "grades")).toHaveLength(1);
    expect(["", " ", "-", " – ", "—", "−"].map(hasGrade)).toEqual(Array(6).fill(false));
    expect(["0", "0.00", "0%", "Pass", "-1"].map(hasGrade)).toEqual(Array(5).fill(true));
    expect(parseGradeItem(item({ item_type: "Assignment" }))).toMatchObject({ modname: "assign" });
    expect(parseGradeItem(item({ url: "https://moodle.example.edu/mod/assign/view.php" }))).toMatchObject({ modname: "assign" });
  });
  it("keeps MCP's default as summary", async () => {
    expect((await mcp({ unit: "algo-2" })).structuredContent).toMatchObject({ mode: "summary" });
  });
});

describe("grade item parsing", () => {
  it("reads stable module and cmid from translated activity links", () => {
    expect(parseGradeItem({ item_type: "作业", url: "https://moodle.example.edu/mod/assign/view.php?id=42" })).toMatchObject({ modname: "assign", cmid: 42 });
  });
  it.each(["", "?id=0", "?id=-1", "?id=1.5", "?id=broken"])("does not invent a cmid for %s", query => {
    expect(parseGradeItem({ url: `https://moodle.example.edu/mod/quiz/view.php${query}` })).not.toHaveProperty("cmid");
  });
  it("preserves manual grade rows without an activity URL", () => {
    expect(parseGradeItem({ name: "Participation", item_type: "Manual", grade: "0" })).toMatchObject({ name: "Participation", modname: "manual", grade: "0" });
  });
});

describe("cross-unit grade pagination", () => {
  const reports = [{ code: "a", items: [1, 2] }, { code: "empty", items: [] }, { code: "b", items: [3, 4, 5] }];
  it.each([
    [0, 3, [[1, 2], [], [3]], 3, true],
    [1, 2, [[2], [], [3]], 2, true],
    [2, 2, [[], [], [3, 4]], 2, true],
    [4, 2, [[], [], [5]], 1, false],
    [5, 2, [[], [], []], 0, false],
    [9, 2, [[], [], []], 0, false],
  ])("pages offset %i with limit %i", (offset, limit, items, returned, has_more) => {
    const page = pageGradeReports(reports, limit, offset);
    expect(page).toMatchObject({ matched: 5, returned, offset, has_more });
    expect(page.pages.map(r => r.items)).toEqual(items);
    expect(page.pages.map(r => r.code)).toEqual(["a", "empty", "b"]);
    expect(reports[0].items).toEqual([1, 2]);
  });
  it("handles no units", () => {
    expect(pageGradeReports([], 20, 0)).toEqual({ pages: [], matched: 0, returned: 0, offset: 0, has_more: false });
  });
});
