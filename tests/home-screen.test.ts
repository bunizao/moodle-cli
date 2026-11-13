import { describe, expect, it } from "vitest";
import { renderScreen } from "../src/screens.js";

const home = (units: string[]) => ({
  home: { name: "Alex", today: "2026-09-15", timezone: "Europe/Berlin", timezone_source: "site", siteurl: "https://moodle.example.edu", units: units.map(code => ({ code })), due: [], unread: { direct_message_count: 2, starred_message_count: 1, notification_count: 0 } },
});

describe("home screen", () => {
  it("wraps a long unit list between names, under the first one", () => {
    const screen = renderScreen(home(["UNIT1001_S2_2026", "UNIT1002_S2_2026", "UNIT1003_S2_2026", "Student-Portal"]), { width: 60, now: Date.UTC(2026, 8, 15) });
    expect(screen).toContain("Units    UNIT1001_S2_2026 · UNIT1002_S2_2026\n         UNIT1003_S2_2026 · Student-Portal");
    expect(screen).toContain("Due      nothing due soon");
    // A zero count is not news.
    expect(screen).toContain("Unread   2 direct messages · 1 starred message\n");
  });

  it("carries a newer release as its own row", () => {
    const screen = renderScreen(home(["UNIT1001"]), { width: 80, now: Date.UTC(2026, 8, 15), update: { current: "0.11.1", latest: "0.12.0" } });
    expect(screen).toContain("Update   0.12.0 is out, you have 0.11.1 · moodle update");
    expect(renderScreen(home(["UNIT1001"]), { width: 80 })).not.toContain("Update");
  });
});
