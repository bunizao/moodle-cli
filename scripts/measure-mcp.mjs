import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const directory = await mkdtemp(join(tmpdir(), "moodle-measure-"));
try {
  const output = join(directory, "measure.mjs");
  await build({ stdin: { contents: `export { createMoodleMcpServer, TOOL_CATALOG } from './src/mcp/server.ts'; export { fixtureGateway, intentCalls } from './tests/fixtures/intent-site.ts';`, resolveDir: resolve(".") }, outfile: output, platform: "node", format: "esm", bundle: true });
  const { createMoodleMcpServer, TOOL_CATALOG, fixtureGateway, intentCalls } = await import(pathToFileURL(output).href);
  const server = createMoodleMcpServer(fixtureGateway());
  const rows = [{ tool: "tools/list", chars: JSON.stringify(TOOL_CATALOG).length }];
  for (const [name, args] of intentCalls) {
    const response = await server.handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }, { protocolVersion: "2025-06-18" });
    if (response.result?.isError || response.error) throw new Error(`Fixture failed: ${name}`);
    rows.push({ tool: name, chars: response.result.content[0].text.length });
  }
  console.table(rows.map(row => ({ ...row, estimated_tokens: Math.ceil(row.chars / 3.6) })));
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows));
} finally { await rm(directory, { recursive: true, force: true }); }
