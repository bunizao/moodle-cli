import type { Ui } from "@bunizao/cli-kit";

export const MOODLE_TAGLINE = "Read Moodle and submit work from the command line.";

// An 8-pixel lowercase face drawn with half blocks, two pixel rows per terminal row,
// so the bowls stay round at four lines tall. Kept as lines so the spacing survives as typed.
export const MOODLE_WORDMARK = [
  "                       █ █",
  "▄▄▄ ▄▄  ▄▄▄   ▄▄▄   ▄▄▄█ █  ▄▄▄",
  "█  █  █ █   █ █   █ █   █ █ █▄▄▄█",
  "█  █  █ ▀▄▄▄▀ ▀▄▄▄▀ ▀▄▄▄█ █ ▀▄▄▄▄",
].join("\n");

let shown = false;

/** The wordmark opens the first guided step of a run and no other, however many steps follow. */
export function showWordmark(ui: Ui): void {
  if (shown) return;
  shown = true;
  ui.banner(MOODLE_WORDMARK, MOODLE_TAGLINE);
}
