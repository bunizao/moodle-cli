import { describe, expect, it } from "vitest";
import { quizOutcome, quizResultSummary } from "../src/mcp/widget/quiz-outcome.js";

describe("quiz review result", () => {
  it("reports full marks only when every question is marked correct", () => {
    expect(quizResultSummary([{ number: 1, mark: "1.00 out of 1.00" }, { number: 2, state: "Correct" }])).toBe("Full marks on every question.");
    expect(quizResultSummary([{ number: 1 }, { number: 2, state: "Correct" }])).toContain("Some questions may not be marked");
    expect(quizResultSummary([{ number: 1 }])).not.toContain("Full marks");
    expect(quizResultSummary([])).not.toContain("Full marks");
    expect(quizOutcome({ number: 1, state: "Incorrect" })).toBe("wrong");
  });
});
