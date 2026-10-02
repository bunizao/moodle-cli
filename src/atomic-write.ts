import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  /** File mode for the result. Defaults to the existing file's mode, so a rewrite never loosens it. */
  mode?: number;
  /** Mode for directories created on the way. */
  directoryMode?: number;
}

/**
 * Write through a temporary sibling and rename it into place. A crash or a full disk then leaves
 * the old file or the new one, never a truncated config that the next reader (ours, or another
 * app's such as ~/.claude.json) fails to parse. A symlinked target is resolved first, so a
 * dotfile manager's link survives the rename.
 */
export async function writeFileAtomic(path: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  const target = await realpath(path).catch(() => path);
  await mkdir(dirname(target), { recursive: true, ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode }) });
  const mode = options.mode ?? await stat(target).then((info) => info.mode & 0o777, () => 0o666);
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
