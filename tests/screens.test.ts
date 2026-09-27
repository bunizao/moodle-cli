import { afterEach, expect, it } from "vitest";
import { createIntentService } from "../src/intents.js";
import { renderScreen, tryLines } from "../src/screens.js";
import { configureTerminalTables } from "../src/terminal-table.js";
import { fixtureGateway } from "./fixtures/intent-site.js";

const NOW = Date.UTC(2026, 8, 15);
const ESC = String.fromCharCode(27);

afterEach(() => configureTerminalTables({ color: () => false }));

it("tones a due date inside the grades table instead of leaking half-stripped escape codes", async () => {
  const data = await createIntentService(fixtureGateway()).run("grades", { unit: "algo-2" });
  const plain = renderScreen(data, { width: 120, now: NOW });
  expect(plain).toContain("│ in 4 days · Sat 19 Sep, 15:55 │");
  expect(plain).not.toMatch(/\[2m|\[22m/u);
  configureTerminalTables({ color: () => true });
  const coloured = renderScreen(data, { width: 120, color: true, now: NOW });
  expect(coloured).toContain(`${ESC}[2min 4 days · Sat 19 Sep, 15:55${ESC}[22m`);
});

it("counts calendar days on the site's clock and says when an item only opens", () => {
  // Sunday 27 September, 19:30 in a +10:00 site.
  const now = Date.parse("2026-09-27T19:30:00+10:00");
  const row = (due: string, event = "due") => ({ unit_code: "UNIT", name: "Task", event, due, due_at: Date.parse(due) / 1000 });
  const screen = renderScreen({ due: [
    row("2026-09-27T21:00:00+10:00"),
    row("2026-09-28T23:55:00+10:00"),
    row("2026-09-28T05:00:00+10:00", "open"),
    row("2026-09-27T18:00:00+10:00"),
    row("2026-09-26T23:55:00+10:00"),
    row("2026-10-03T23:55:00+10:00"),
  ], total: 6 }, { width: 120, now });
  expect(screen).toContain("today · Sun 27 Sep, 21:00");
  expect(screen).toContain("tomorrow · Mon 28 Sep, 23:55");
  expect(screen).toContain("opens tomorrow · Mon 28 Sep, 05:00");
  expect(screen).toContain("overdue · Sun 27 Sep, 18:00");
  expect(screen).toContain("1 day overdue · Sat 26 Sep, 23:55");
  expect(screen).toContain("in 6 days · Sat 3 Oct, 23:55");
});

it("names an empty list after the command, since the empty array itself is dropped", () => {
  expect(renderScreen({ total: 0 }, { intent: "news" })).toMatch(/^News\n {2}None\n0 total/u);
  expect(renderScreen({ total: 0 }, { intent: "due" })).toMatch(/^Due\n {2}None/u);
});

it("lists the next commands one per line", () => {
  expect(tryLines(["moodle due", "moodle grades"])).toBe("Try  moodle due\n     moodle grades");
});
