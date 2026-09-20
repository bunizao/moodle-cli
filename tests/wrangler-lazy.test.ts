import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { resolveWrangler } from "../src/mcp/wrangler.js";
import { WRANGLER_VERSION } from "../src/constants.js";

it("resolves PATH, cached and first-use Wrangler without installing for construction", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "moodle-wrangler-")));
  const bin = join(home, "bin");
  await mkdir(bin);
  const executable = async (name: string) => { const file = join(bin, name); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o755); return file; };
  const node = await executable("node");
  const wrangler = await executable("wrangler");
  const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
  try {
    run.mockImplementationOnce(async () => ({ stdout: ` ⛅️ wrangler ${WRANGLER_VERSION}\n`, stderr: "" }));
    expect(await resolveWrangler({ run }, { homeDir: home, env: { PATH: bin } })).toEqual({ command: wrangler, args: [] });
    expect(run).toHaveBeenCalledWith(wrangler, ["--version"]);
    // A PATH Wrangler from another major line is ignored rather than trusted.
    run.mockClear();
    run.mockImplementationOnce(async () => ({ stdout: "wrangler 3.99.0\n", stderr: "" }));
    const notice = vi.fn();
    await expect(resolveWrangler({ run }, { homeDir: home, env: { PATH: bin }, notice })).rejects.toThrow(/Install Bun or npm/);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("3.99.0"));
    run.mockClear();
    await rm(wrangler);
    const cached = join(home, ".config", "moodle-cli", "tools", `wrangler@${WRANGLER_VERSION}`, "node_modules", "wrangler", "bin", "wrangler.js");
    await mkdir(join(cached, ".."), { recursive: true }); await writeFile(cached, "");
    expect(await resolveWrangler({ run }, { homeDir: home, env: { PATH: bin } })).toEqual({ command: node, args: [cached] });
    expect(run).not.toHaveBeenCalled();
    await rm(cached); const npm = await executable("npm");
    run.mockImplementationOnce(async () => { await writeFile(cached, ""); return { stdout: "", stderr: "" }; });
    const download = vi.fn();
    expect(await resolveWrangler({ run }, { homeDir: home, env: { PATH: bin }, yes: true, notice: download })).toEqual({ command: node, args: [cached] });
    expect(run).toHaveBeenCalledWith(npm, expect.arrayContaining([`wrangler@${WRANGLER_VERSION}`, "--prefix"]));
    expect(download).toHaveBeenCalledOnce();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("pins the tool directory with a package.json and reports the installer output when nothing was installed", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "moodle-wrangler-")));
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const name of ["node", "npm"]) { const file = join(bin, name); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o755); }
  const root = join(home, ".config", "moodle-cli", "tools", `wrangler@${WRANGLER_VERSION}`);
  // An installer that walks up to a parent package.json exits 0 and leaves the tool directory empty.
  const run = vi.fn(async () => ({ stdout: "", stderr: "npm warn saveError ENOENT\n" }));
  try {
    const failure = await resolveWrangler({ run }, { homeDir: home, env: { PATH: bin }, yes: true, notice: () => undefined }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/did not create .*wrangler\.js\.\nnpm warn saveError ENOENT\nRemove .* and retry moodle mcp deploy\./u);
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({ private: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});
