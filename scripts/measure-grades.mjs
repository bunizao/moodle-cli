import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Replay both versions against one in-memory snapshot; never persist gradebooks
// or credentials. Keep the baseline pinned to the PR's pre-change implementation.
const baseline = "8db3553f6cd954ee9f472078291a6c344e8428dd";
const directory = await mkdtemp(join(tmpdir(), "moodle-grade-measure-"));
let stage = "building comparison";
async function bundle(root, contents, name) {
  const outfile = join(directory, `${name}.mjs`);
  await build({
    stdin: { contents, resolveDir: root }, outfile, bundle: true, format: "esm", platform: "node",
    plugins: [{ name: "repository-dependencies", setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    } }],
  });
  return import(pathToFileURL(outfile).href);
}
async function textFor(server, args) {
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "grades", arguments: args } }, { protocolVersion: "2025-06-18" });
  if (response.error || response.result?.isError) throw new Error("Grade measurement failed");
  return { text: response.result.content[0].text, data: response.result.structuredContent };
}
async function measure(label, gateway, unit, oldServer, newServer) {
  const args = unit === undefined ? {} : { unit };
  const old = await textFor(oldServer(gateway), args);
  const rows = [{ variant: "old default", calls: 1, chars: old.text.length }];
  for (const mode of ["summary", "graded", "all"]) {
    for (const include_feedback of [false, true]) {
      let offset = 0, chars = 0, calls = 0, data;
      do {
        const page = await textFor(newServer(gateway), { ...args, mode, include_feedback, offset });
        chars += page.text.length;
        calls++;
        data = page.data;
        offset += data.returned ?? 0;
      } while (data.has_more);
      rows.push({ variant: `${mode}${include_feedback ? " + feedback" : ""}`, calls, chars });
    }
  }
  for (const includeFeedback of [false, true]) {
    const summary = rows.find(r => r.variant === "summary");
    const graded = rows.find(r => r.variant === `graded${includeFeedback ? " + feedback" : ""}`);
    rows.push({ variant: `summary then graded${includeFeedback ? " + feedback" : ""}`, calls: summary.calls + graded.calls, chars: summary.chars + graded.chars });
  }
  return { dataset: label, units: unit === undefined ? (await gateway.listCourses()).length : 1, rows: rows.map(row => ({ ...row, approximate_tokens: Math.ceil(row.chars / 3.6), reduction_percent: Number((100 * (1 - row.chars / old.text.length)).toFixed(1)) })) };
}
try {
  execFileSync("tar", ["-xf", "-", "-C", directory], { input: execFileSync("git", ["archive", baseline, "src", "package.json"], { maxBuffer: 16 * 1024 * 1024 }) });
  const old = await bundle(directory, "export { createMoodleMcpServer } from './src/mcp/server.ts';", "old");
  const current = await bundle(resolve("."), "export { createMoodleMcpServer } from './src/mcp/server.ts'; export { gradebook } from './tests/fixtures/gradebook.ts'; export { createMoodleGateway } from './src/mcp/gateway.ts'; export { createMoodleClient } from './src/client.ts'; export { loadConfig } from './src/config.ts';", "current");
  const results = [await measure("45-item fixture", current.gradebook(), "algo-2", old.createMoodleMcpServer, current.createMoodleMcpServer)];
  if (process.argv.includes("--live")) {
    stage = "loading Moodle configuration";
    const { baseUrl } = await current.loadConfig({ stdin: { isTTY: false } });
    stage = "opening the existing Moodle session";
    const gateway = current.createMoodleGateway(await current.createMoodleClient(baseUrl, { nonInteractive: true }));
    stage = "reading enrolled units and gradebooks";
    const courses = await gateway.listCourses();
    const user = await gateway.getUser();
    const reports = new Map(), deadlines = new Map();
    for (const course of courses) {
      reports.set(course.id, await gateway.getGrades({ courseId: course.id }));
      deadlines.set(course.id, await gateway.getDue(365, course.id));
    }
    const snapshot = { ...gateway, listCourses: async () => courses, getUser: async () => user, getGrades: async ({ courseId }) => reports.get(courseId), getDue: async (_days, courseId) => deadlines.get(courseId) };
    results.push(await measure("real gradebook, all enrolled units", snapshot, undefined, old.createMoodleMcpServer, current.createMoodleMcpServer));
  }
  console.log(JSON.stringify({ baseline, metric: "MCP content[0].text characters, summed over every page", token_estimate: "ceil(chars / 3.6), not a tokenizer count", results }, null, 2));
} catch (error) {
  // Library errors may contain URLs or auth details; report only the error class.
  console.error(`Grade measurement unavailable while ${stage} (${error instanceof Error ? error.name : "unknown error"}).`);
  if (!process.argv.includes("--live")) console.error(error);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
