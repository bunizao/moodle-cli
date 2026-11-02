import { readFile } from "node:fs/promises";

const bareImportsOf = (source) => [...source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^./][^"']*)["']/gu)]
  .map((match) => match[1]);

// The standalone Worker is deployed as one file, so only the runtime's own module may stay an import.
for (const name of ["worker", "recovery"]) {
  const source = await readFile(new URL(`../dist/worker/${name}.js`, import.meta.url), "utf8");
  const external = bareImportsOf(source).filter((specifier) => specifier !== "cloudflare:workers");
  if (external.length) {
    throw new Error(`Worker bundle contains external imports: ${[...new Set(external)].join(", ")}`);
  }
}

// The library runs inside a host Worker: package dependencies are fine, Node built-ins are not.
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const dependencies = Object.keys(manifest.dependencies ?? {});
const library = await readFile(new URL("../dist/lib/worker.js", import.meta.url), "utf8");
const unexpected = bareImportsOf(library).filter((specifier) => specifier !== "cloudflare:workers"
  && !dependencies.some((name) => specifier === name || specifier.startsWith(`${name}/`)));
if (unexpected.length) {
  throw new Error(`Worker library imports outside its dependencies: ${[...new Set(unexpected)].join(", ")}`);
}
