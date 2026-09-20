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
  expect(plain).toContain("│ in 5 days · Sat 19 Sep, 15:55 │");
  expect(plain).not.toMatch(/\[2m|\[22m/u);
  configureTerminalTables({ color: () => true });
  const coloured = renderScreen(data, { width: 120, color: true, now: NOW });
  expect(coloured).toContain(`${ESC}[2min 5 days · Sat 19 Sep, 15:55${ESC}[22m`);
});

it("lists the next commands one per line", () => {
  expect(tryLines(["moodle due", "moodle grades"])).toBe("Try  moodle due\n     moodle grades");
});
