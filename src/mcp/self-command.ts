import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface SelfCommand { command: string; args: string[] }
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const file = join(dir, name + suffix);
      try { accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* Try the next PATH entry. */ }
    }
  }
  return undefined;
}
export function selfCommand(argv: readonly string[] = process.argv, execPath = process.execPath): SelfCommand {
  const script = argv[1];
  const standalone = !script || script === execPath || /(?:\$bunfs|~BUN)/u.test(script);
  return standalone ? { command: execPath, args: [] } : { command: execPath, args: [script] };
}
export function runtimeSupportsCookies(command = process.execPath): boolean {
  if (command === process.execPath && process.versions.bun) return true;
  return spawnSync(command, ["-e", 'if (!process.versions.bun) require("node:sqlite")'], { stdio: "ignore", timeout: 5000 }).status === 0;
}
export function runtimeCommand(command?: string, args?: readonly string[]): SelfCommand {
  if (command) return { command, args: [...(args ?? [])] };
  const running = selfCommand();
  if (!running.args.length) return running;
  const bun = findExecutable("bun");
  if (bun) return { command: bun, args: running.args };
  if (runtimeSupportsCookies()) return running;
  throw new Error("The runtime cannot read browser cookies. Install Bun or Node 22.13+, then run moodle doctor.");
}
