const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_INTERVAL_MS = 100;
const ELAPSED_AFTER_MS = 2000;
const CLEAR_LINE = "\r\u001B[2K";

export interface ProgressReporterOptions {
  stream?: NodeJS.WritableStream;
  interactive?: boolean;
  intervalMs?: number;
  now?: () => number;
}

export interface ProgressReporter {
  /** Announce a step that is now running. Animates in place on a TTY. */
  begin(text: string): void;
  /** Replace the animated line with a permanent one. */
  end(text: string): void;
  /** Drop the animated line without recording an outcome. */
  clear(): void;
}

/**
 * Deployment steps shell out to Wrangler and wait on Cloudflare, so a step can run for
 * a minute with nothing to print. On a TTY the running step is redrawn in place with a
 * spinner and its elapsed time; elsewhere only completed steps are written, because
 * piped output is read after the fact and in-place redraws would only be noise.
 */
export function createProgressReporter(options: ProgressReporterOptions = {}): ProgressReporter {
  const stream = options.stream ?? process.stderr;
  const interactive = options.interactive ?? Boolean((stream as NodeJS.WriteStream).isTTY);
  const intervalMs = options.intervalMs ?? FRAME_INTERVAL_MS;
  const now = options.now ?? Date.now;

  let timer: NodeJS.Timeout | undefined;
  let active = "";
  let startedAt = 0;
  let frame = 0;

  function paint(): void {
    const elapsed = now() - startedAt;
    const suffix = elapsed >= ELAPSED_AFTER_MS ? ` ${Math.round(elapsed / 1000)}s` : "";
    stream.write(`${CLEAR_LINE}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${active}${suffix}`);
    frame += 1;
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    stream.write(CLEAR_LINE);
  }

  return {
    begin(text) {
      if (!interactive) return;
      stop();
      active = text;
      startedAt = now();
      frame = 0;
      paint();
      timer = setInterval(paint, intervalMs);
      // A progress animation must never be the reason the process stays alive.
      timer.unref?.();
    },
    end(text) {
      stop();
      stream.write(`${text}\n`);
    },
    clear() {
      stop();
    },
  };
}
