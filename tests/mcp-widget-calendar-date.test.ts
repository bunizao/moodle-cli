import { describe, expect, it } from "vitest";
import { nextCalendarDay } from "../src/mcp/widget/calendar-date.js";

describe("deadline calendar days", () => {
  it("advances by calendar date across DST and year boundaries", () => {
    expect(nextCalendarDay("2026-04-05")).toBe("2026-04-06");
    expect(nextCalendarDay("2026-10-04")).toBe("2026-10-05");
    expect(nextCalendarDay("2026-12-31")).toBe("2027-01-01");
  });
});
