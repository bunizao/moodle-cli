import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const SITE = "https://moodle.example.edu";

// A slow site on a terminal shows the loading spinner on stderr. A command that writes
// its result straight to stdout shares that screen, so the spinner must be gone first or
// its next frame, or its clear, lands on top of the output.
it("settles the loading spinner before a command writes to stdout directly", async () => {
  const home = await mkdtemp(join(tmpdir(), "moodle-spinner-"));
  const log: string[] = [];
  const slow: typeof fetch = async input => {
    await new Promise(resolve => setTimeout(resolve, 400));
    const url = new URL(String(input));
    if (url.pathname === "/my/") return new Response('<html><script>M.cfg={"sesskey":"fixture","userid":7}</script></html>');
    return new Response("<html>page</html>", { headers: { "content-type": "text/html" } });
  };
  try {
    const code = await runCli(["node", "moodle", "dev", "fetch", `${SITE}/mod/page/view.php?id=1`, "--no-cache"], {
      env: { MOODLE_BASE_URL: SITE, MOODLE_SESSION: "fixture", MOODLE_NO_UPDATE_CHECK: "1" }, homeDir: home, cwd: home,
      fetchImpl: slow, stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: { isTTY: true, write: (value: string) => { log.push(`out:${value}`); return true; } } as NodeJS.WriteStream,
      stderr: { isTTY: true, columns: 80, rows: 24, write: (value: string) => { log.push(`err:${value}`); return true; }, on() { return this; }, once() { return this; }, off() { return this; }, removeListener() { return this; } } as unknown as NodeJS.WriteStream,
    });
    expect(code).toBe(0);
    const firstOut = log.findIndex(entry => entry.startsWith("out:"));
    expect(log.slice(0, firstOut).some(entry => entry.includes("Loading Moodle"))).toBe(true);
    expect(log.slice(firstOut).filter(entry => entry.startsWith("err:"))).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
