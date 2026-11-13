import type { Ui } from "@bunizao/cli-kit";

export const MOODLE_TAGLINE = "Read Moodle and submit work from the command line.";

// figlet "Small"; kept as lines so the backslashes and the backtick survive as typed.
export const MOODLE_WORDMARK = [
  "                     _ _",
  "  _ __  ___  ___  __| | |___",
  " | '  \\/ _ \\/ _ \\/ _` | / -_)",
  " |_|_|_\\___/\\___/\\__,_|_\\___|",
].join("\n");

let shown = false;

/** The wordmark opens the first guided step of a run and no other, however many steps follow. */
export function showWordmark(ui: Ui): void {
  if (shown) return;
  shown = true;
  ui.banner(MOODLE_WORDMARK, MOODLE_TAGLINE);
}
