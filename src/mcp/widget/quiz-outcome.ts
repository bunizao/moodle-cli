import type { QuizQuestion } from "./views.js";

export type Outcome = "right" | "partial" | "wrong" | "open";

// Marks are more reliable than translated state labels.
export function quizOutcome(question: QuizQuestion): Outcome {
  const [got, max] = (question.mark?.match(/\d+(?:[.,]\d+)?/gu) ?? []).map((value) => Number.parseFloat(value.replace(",", ".")));
  if (got !== undefined && max !== undefined && max > 0) return got >= max ? "right" : got <= 0 ? "wrong" : "partial";
  const state = (question.state ?? "").toLowerCase();
  if (state.includes("partial")) return "partial";
  if (state.includes("incorrect") || state.includes("wrong")) return "wrong";
  if (state.includes("correct")) return "right";
  return "open";
}

export function quizResultSummary(questions: QuizQuestion[]): string {
  return questions.length > 0 && questions.every((question) => quizOutcome(question) === "right")
    ? "Full marks on every question."
    : "Review complete. Some questions may not be marked yet.";
}
