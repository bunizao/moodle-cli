import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createIntentService } from "../src/intents.js";
import { intentContracts, intentDescription, type Intent } from "../src/intent-contract.js";
import { createMoodleMcpServer, TOOL_CATALOG } from "../src/mcp/server.js";
import { fixtureGateway, intentCalls } from "./fixtures/intent-site.js";
import { renderScreen } from "../src/screens.js";

function walk(value: unknown, visit: (v: unknown) => void) { visit(value); if (value && typeof value === "object") for (const child of Object.values(value)) walk(child, visit); }
async function call(name: string, args: unknown = {}, gateway = fixtureGateway()) {
  const response = await createMoodleMcpServer(gateway).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { protocolVersion: "2025-06-18" });
  return (response as { result: { structuredContent: Record<string, unknown>; content: { type: string; text: string }[]; isError?: boolean } }).result;
}
describe("shared intent contract", () => {
  it.each(intentCalls)("%s has identical validated CLI and MCP payloads", async (name, args) => {
    const result = await call(name, args);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(await createIntentService(fixtureGateway()).run(name, args));
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    walk(result.structuredContent, value => { expect(value).not.toBe(""); if (Array.isArray(value)) expect(value.length).toBeGreaterThan(0); });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toMatch(/message_html|profile_image_url|course_name|fullname|created_pretty/);
    expect(intentContracts[name].output.safeParse(result.structuredContent).success).toBe(true);
  });
  it("keeps every input default optional and every output object closed", () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.description).toBe(intentDescription(tool.name as Intent));
      const input = tool.inputSchema as { properties: Record<string, { default?: unknown }>; required?: string[] };
      for (const key of input.required ?? []) expect(input.properties[key]).not.toHaveProperty("default");
      walk(tool.outputSchema, node => { if (node && typeof node === "object" && (node as { type?: string }).type === "object" && "properties" in node) expect(node).toHaveProperty("additionalProperties", false); });
    }
    expect(TOOL_CATALOG).toHaveLength(11);
  });
  it("makes ambiguous names actionable, and resolves a complete phrase in one call", async () => {
    expect(await call("item", { ref: "algo-2 mini test" })).toMatchObject({ isError: true, structuredContent: { error: { code: "ambiguous", candidates: [{ id: 201 }, { id: 211 }] } } });
    expect(await call("item", { ref: "algo-2 week 7 mini test" })).toMatchObject({ structuredContent: { item: { id: 201 } } });
    expect(await call("unit", { unit: "Ethics", section: 7 })).toMatchObject({ structuredContent: { unit: { id: 4 }, sections: [{ name: "Week 7" }] } });
  });
  it("filters before counting and paginates posts without repeating the subject", async () => {
    expect(await call("due", { unit: "algo-2", limit: 1 })).toMatchObject({ structuredContent: { total: 1, due: [{ unit_id: 2 }] } });
    const result = await call("thread", { discussion_id: 60, limit: 2, offset: 20 });
    expect(result).toMatchObject({ structuredContent: { thread: { posts_total: 25, offset: 20, posts: [{ id: 90 }, { id: 91 }] } } });
    expect(JSON.stringify(result.structuredContent).match(/Assignment released/g)).toHaveLength(1);
  });
  it("includePostText changes fields, never matching discussion ids", async () => {
    const yes = (await call("search_forums", { query: "assignment", includePostText: true })).structuredContent;
    const no = (await call("search_forums", { query: "assignment", includePostText: false })).structuredContent;
    expect((yes.results as { discussion_id: number }[]).map(r => r.discussion_id)).toEqual((no.results as { discussion_id: number }[]).map(r => r.discussion_id));
    expect(JSON.stringify(no)).not.toContain("snippet");
  });
  it("reports omitted empty lists with a truthful total", async () => {
    const gateway = fixtureGateway(); gateway.listCourses = async () => [];
    expect((await call("units", {}, gateway)).structuredContent).toEqual({ total: 0 });
  });
  it.each([60, 80, 100, 120])("renders grades at %i columns with complete grade values", async width => {
    const data = await createIntentService(fixtureGateway()).run("grades", {});
    const screen = renderScreen(data, { width });
    expect(screen).toContain("0–10");
    expect(screen).toContain("Try  ");
    expect(screen).not.toContain("[object Object]");
  });
  it("pins the home, section, item and grades screens at 80 columns", async () => {
    const service = createIntentService(fixtureGateway(), () => Date.UTC(2026, 8, 15));
    for (const [name, args] of [["home", {}], ["unit", { unit: "algo-2", section: 7 }], ["item", { ref: 201 }], ["grades", { unit: "algo-2" }]] as const) {
      const screen = renderScreen(await service.run(name, args), { width: 80, now: Date.UTC(2026, 8, 15) });
      expect(screen).toMatchSnapshot(name);
      expect(Math.max(...screen.split("\n").map(line => Array.from(line).length))).toBeLessThanOrEqual(80);
    }
  });
  it("pins honest fixture payload budgets independently from catalog cost", async () => {
    const budgets = { home: 2000, due: 300, units: 600, unit: 600, find: 500, item: 500, grades: 1500, news: 500, thread: 600, search_forums: 600, file: 250 };
    for (const [name, args] of intentCalls) expect(JSON.stringify((await call(name, args)).structuredContent).length, name).toBeLessThanOrEqual(budgets[name]);
    expect(JSON.stringify(TOOL_CATALOG).length).toBeLessThanOrEqual(20000);
  });
  it("strips undeclared source properties before emitting", () => {
    const value = { item: { id: 1, type: "resource", secret: "should not survive" } };
    expect(intentContracts.item.output.parse(value)).toEqual({ item: { id: 1, type: "resource" } });
  });
});
