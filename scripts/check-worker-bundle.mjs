import { readFile } from "node:fs/promises";

const bundlePath = new URL("../dist/worker/worker.js", import.meta.url);
const source = await readFile(bundlePath, "utf8");
const bareImports = [...source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^./][^"']*)["']/gu)]
  .map((match) => match[1]);

if (bareImports.length) {
  throw new Error(`Worker bundle contains external imports: ${[...new Set(bareImports)].join(", ")}`);
}
