import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface SelfCommand { command: string; args: string[] }
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, host = process.platform): string | undefined {
  // A copied Windows environment keeps the real key casing, which is usually "Path".
  // Windows never runs an extensionless file, so a shell script named "npm" is not a match.
  const path = env.PATH ?? (host === "win32" ? env.Path : undefined) ?? "";
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const suffix of host === "win32" ? [".exe", ".cmd", ".bat"] : [""]) {
      const file = join(dir, name + suffix);
      try { accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* Try the next PATH entry. */ }
    }
  }
  return undefined;
}
export interface SpawnTarget { command: string; args: string[]; shell: boolean }
/**
 * How to spawn a command found by findExecutable. Node refuses to spawn a .cmd or .bat
 * without a shell (CVE-2024-27980), and npm and global installs like Wrangler are .cmd
 * shims on Windows. Through cmd.exe, anything with a space must be quoted.
 */
export function spawnTarget(command: string, args: readonly string[], host = process.platform): SpawnTarget {
  if (host !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) return { command, args: [...args], shell: false };
  const quote = (value: string) => /[\s&()^|<>]/u.test(value) ? `"${value}"` : value;
  return { command: quote(command), args: args.map(quote), shell: true };
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
