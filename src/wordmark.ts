import type { Ui } from "@bunizao/cli-kit";

export const MOODLE_TAGLINE = "Read Moodle and submit work from the command line.";

// A light, rounded monoline face in box-drawing characters. Horizontal strokes sit at
// mid-row, so the half stems (╵) end exactly on the baseline the bowls close on.
export const MOODLE_WORDMARK = [
  "                        │ │",
  "╭──┬──╮ ╭───╮ ╭───╮ ╭───┤ │  ╭───╮",
  "│  │  │ │   │ │   │ │   │ │  ├───╯",
  "╵  ╵  ╵ ╰───╯ ╰───╯ ╰───┘ ╰─ ╰───╴",
].join("\n");

let shown = false;

/** The wordmark opens the first guided step of a run and no other, however many steps follow. */
export function showWordmark(ui: Ui): void {
  if (shown) return;
  shown = true;
  ui.banner(MOODLE_WORDMARK, MOODLE_TAGLINE);
}
