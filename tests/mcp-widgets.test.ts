import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { MODERN_PROTOCOL_VERSION, mirroredName } from "../src/mcp/protocol.js";
import { createMoodleMcpServer, WIDGET_CATALOG } from "../src/mcp/server.js";
import { WIDGET_HTML } from "../src/mcp/widget-html.generated.js";
import { WIDGET_MIME_TYPE, WIDGET_URI, WIDGET_VIEW_KEY } from "../src/mcp/widgets.js";
import { renderWidgetModule } from "../scripts/build-widget.mjs";
import { fixtureGateway } from "./fixtures/intent-site.js";

const SHOW_TOOLS = ["show_deadlines", "show_grades", "show_quiz_review", "show_unit"];

async function rpc(method: string, params: Record<string, unknown> = {}, options: { widgets?: boolean } = {}) {
  const server = createMoodleMcpServer(fixtureGateway(), options);
  const _meta = method === "initialize" ? undefined : {
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
  };
  return await server.handle({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...(_meta && { _meta }) } }) as { result?: Record<string, any>; error?: { code: number } };
}

async function show(name: string, args: Record<string, unknown>) {
  const { result } = await rpc("tools/call", { name, arguments: args });
  expect(result?.isError).toBeFalsy();
  return { view: result!._meta[WIDGET_VIEW_KEY], text: result!.content[0].text as string, result: result! };
}

describe("MCP Apps widgets", () => {
  it("serves one self-contained HTML resource", async () => {
    const list = await rpc("resources/list");
    expect(list.result?.resources).toEqual([expect.objectContaining({ uri: WIDGET_URI, mimeType: WIDGET_MIME_TYPE })]);

    const read = await rpc("resources/read", { uri: WIDGET_URI });
    const [content] = read.result?.contents;
    expect(content).toMatchObject({ uri: WIDGET_URI, mimeType: WIDGET_MIME_TYPE });
    expect(content.text).toBe(WIDGET_HTML);
    // Hosts sandbox the iframe without network, so nothing may load from elsewhere.
    expect(content.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);

    expect((await rpc("resources/read", { uri: "ui://moodle/other.html" })).error?.code).toBe(-32002);
  });

  it("points every show_* tool at the widget, legacy key included", async () => {
    const tools = (await rpc("tools/list")).result?.tools as Array<Record<string, any>>;
    const shown = tools.filter(tool => SHOW_TOOLS.includes(tool.name));
    expect(shown.map(tool => tool.name)).toEqual(SHOW_TOOLS);
    for (const tool of shown) {
      expect(tool._meta).toEqual({ ui: { resourceUri: WIDGET_URI }, "ui/resourceUri": WIDGET_URI });
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    }
  });

  it("keeps the show_* catalog small, since every model turn pays for it", () => {
    expect(JSON.stringify(WIDGET_CATALOG).length).toBeLessThan(3200);
  });

  it("drops the tools, resources and capability when widgets are off", async () => {
    const tools = (await rpc("tools/list", {}, { widgets: false })).result?.tools as Array<{ name: string }>;
    expect(tools.some(tool => tool.name.startsWith("show_"))).toBe(false);
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } }, { widgets: false });
    expect(init.result?.capabilities).not.toHaveProperty("resources");
    expect((await rpc("resources/list", {}, { widgets: false })).error?.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "show_unit", arguments: { unit: "algo-2" } }, { widgets: false })).error).toBeDefined();
  });

  it("builds the deadlines view", async () => {
    const { view, text } = await show("show_deadlines", { unit: "algo-2", days: 365 });
    expect(view).toMatchObject({ kind: "deadlines", days: 365 });
    expect(view.items).toEqual([expect.objectContaining({ unit_code: "algo-2", name: "Mini Test", due_at: 1789826100 })]);
    expect(text).toMatch(/^1 items due in the next 365 days/);
  });

  it("builds the grades view with marked items only", async () => {
    const { view, text } = await show("show_grades", { unit: "algo-2" });
    expect(view.kind).toBe("grades");
    expect(view.units).toHaveLength(1);
    expect(view.units[0].items.map((item: { name: string }) => item.name)).toEqual(["Quiz"]);
    expect(text).toContain("Quiz: 8 of 0–10 (80%)");
  });

  it("builds the quiz review", async () => {
    const { view, text } = await show("show_quiz_review", { attempt: 777 });
    expect(view).toMatchObject({ kind: "quiz", attempt: { id: 777, marks: "2.00/3.00" } });
    expect(view.attempt.questions[0]).toMatchObject({ number: 1, response: "False", correct: "False" });
    expect(text).toContain("Q1: Correct");
    expect(text).not.toContain("Response: False");
    expect(text).not.toContain("Correct answer: False");
  });

  it("builds the unit outline including labels and the current section", async () => {
    const { view, text } = await show("show_unit", { unit: "algo-2" });
    expect(view).toMatchObject({ kind: "unit", unit: { id: 2, code: "algo-2" }, current: 2000 });
    expect(view.sections.map((s: { name: string }) => s.name)).toEqual(["Week 7", "Week 17"]);
    expect(view.sections[0].activities.map((a: { type: string }) => a.type)).toEqual(["resource", "assign", "label"]);
    expect(text).toContain("2 sections, 6 activities");
    for (const section of view.sections) {
      for (const activity of section.activities) expect(text).toContain(`id ${activity.id}`);
    }
  });

  it("reports a bad reference as a tool error, not a view", async () => {
    const { result } = await rpc("tools/call", { name: "show_unit", arguments: { unit: "no-such-unit" } });
    expect(result?.isError).toBe(true);
    expect(result?._meta).not.toHaveProperty(WIDGET_VIEW_KEY);
  });

  it("ships the widget built from the current source", async () => {
    const file = await readFile(new URL("../src/mcp/widget-html.generated.ts", import.meta.url), "utf8");
    expect(file, "run npm run build:widget").toBe(await renderWidgetModule());
  });

  it("mirrors the resource uri in Mcp-Name", () => {
    expect(mirroredName("resources/read", { uri: WIDGET_URI })).toBe(WIDGET_URI);
    expect(mirroredName("tools/call", { name: "show_unit" })).toBe("show_unit");
    expect(mirroredName("resources/read", { name: "x" })).toBeUndefined();
  });
});
