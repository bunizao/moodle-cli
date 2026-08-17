import { describe, expect, it } from "vitest";

import { formatTodo } from "../src/formatters.js";
import { renderTerminalTable } from "../src/terminal-table.js";

describe("terminal output", () => {
  it("renders todo as a bordered table with readable dates", () => {
    const output = formatTodo([{
      id: 1,
      name: "Assignment 1",
      activity_name: "Assignment 1",
      modname: "assign",
      course_id: 2,
      course_name: "Theory of computation",
      due_at: 1_787_320_500,
      overdue: false,
      actionable: true,
      action_name: "Add submission",
      action_url: "https://example.test/action",
      url: "https://example.test/activity",
      event_type: "due",
    }]);

    expect(output).toContain("Todo");
    expect(output).toContain("┌");
    expect(output).toContain("Assignment 1");
    expect(output).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u);
    expect(output).not.toContain("1787320500");
  });

  it("wraps long cells to the requested terminal width", () => {
    const output = renderTerminalTable(
      [{ label: "ID" }, { label: "Name" }],
      [["1", "A deliberately long activity name that needs wrapping"]],
      { title: "Activities", width: 40 },
    );

    expect(Math.max(...output.split("\n").map((line) => line.length))).toBeLessThanOrEqual(40);
    expect(output).toContain("deliberately long");
  });

  it("keeps empty todo output in a bordered table", () => {
    const output = formatTodo([]);

    expect(output).toContain("Todo");
    expect(output).toContain("┌");
    expect(output).toContain("No upcoming items");
  });

  it("removes terminal control characters from cells", () => {
    const output = renderTerminalTable(
      [{ label: "Name" }],
      [["stu\u0000dent\tname"]],
      { width: 40 },
    );

    expect(output).toContain("student name");
    expect(output).not.toContain("\u0000");
    expect(output).not.toContain("\t");
  });

  it("fits many columns within a narrow terminal", () => {
    const columns = Array.from({ length: 9 }, (_, index) => ({ label: `Column ${index + 1}` }));
    const output = renderTerminalTable(
      columns,
      [columns.map((_, index) => `Value ${index + 1}`)],
      { title: "Narrow", width: 40 },
    );

    expect(Math.max(...output.split("\n").map((line) => line.length))).toBeLessThanOrEqual(40);
  });
});
