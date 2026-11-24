import { z } from "zod";

import type { createIntentService } from "../intents.js";
import { sectionTree } from "../resolve.js";
import type { DeadlinesView, GradesView, QuizView, UnitView, WidgetView } from "./widget/views.js";

// MCP Apps: each show_* tool points at one HTML resource that renders every view.
export const WIDGET_URI = "ui://moodle/widget.html";
export const WIDGET_MIME_TYPE = "text/html;profile=mcp-app";
// The view rides in the result's _meta, which hosts hand to the widget only; the
// model reads the short text content instead of the whole payload.
export const WIDGET_VIEW_KEY = "moodle/view";

export const WIDGET_INSTRUCTIONS = "Use show_* tools for interactive views only when the host supports MCP Apps. Otherwise use due, grades, attempt or unit for plain-text answers and complete fields.";

const ref = z.union([z.string().trim().min(1).max(2048), z.number().int().positive()]);

export const widgetContracts = {
  show_deadlines: {
    title: "Show deadlines",
    description: "Interactive view of items due in a window, grouped by day; the user opens one in place. Use it to see or plan deadlines; for plain text or ids call due. Input: optional unit code, name, id or URL; days defaults to 14.",
    input: z.object({ unit: ref.optional(), days: z.number().int().min(1).max(365).default(14) }).strict(),
  },
  show_grades: {
    title: "Show grades",
    description: "Interactive view of marked items per unit as score bars; the user opens one for marker feedback and rubric rows. Use it for an overview of marks; for plain text call grades. Input: optional unit code, name, id or URL.",
    input: z.object({ unit: ref.optional() }).strict(),
  },
  show_quiz_review: {
    title: "Review a quiz attempt",
    description: "Interactive review of one quiz attempt, question by question, with the user's response and the mark, correct answer and feedback when the site shows them. Use it to go over a quiz; for plain text call attempt. Input: attempt id or review URL, from item.",
    input: z.object({ attempt: ref }).strict(),
  },
  show_unit: {
    title: "Show unit outline",
    description: "Interactive outline of one unit: every section with its activities, the current section open; the user opens items in place. Use it to browse a unit; for plain text call unit. Input: unit code, name, id or URL.",
    input: z.object({ unit: ref }).strict(),
  },
} as const;

export type WidgetTool = keyof typeof widgetContracts;

export function isWidgetTool(name: string): name is WidgetTool {
  return Object.hasOwn(widgetContracts, name);
}

type IntentService = ReturnType<typeof createIntentService>;
type DueRow = { id: number; activity_id?: number; name?: string; type?: string; unit_code?: string; due?: string; due_at: number };
type GradeRow = GradesView["units"][number] & { total_range?: string };

export async function buildWidget(service: IntentService, name: WidgetTool, args: Record<string, unknown>): Promise<{ view: WidgetView; text: string }> {
  switch (name) {
    case "show_deadlines": {
      const input = widgetContracts.show_deadlines.input.parse(args);
      const { due = [], total } = await service.run("due", { ...withUnit(input.unit), days: input.days, limit: 200 }) as { due?: DueRow[]; total: number };
      const view: DeadlinesView = { kind: "deadlines", days: input.days, items: due.map(({ id, activity_id, name, type, unit_code, due_at }) => ({ id, activity_id, name, type, unit_code, due_at })) };
      const lines = [
        `${total} items due in the next ${input.days} days${total > due.length ? `; the view shows the first ${due.length}` : ""}.`,
        ...due.map(row => `- ${row.due ?? ""} ${row.unit_code ?? ""} ${row.name ?? ""} (${[row.type, row.activity_id && `activity ${row.activity_id}`].filter(Boolean).join(", ")})`),
      ];
      return { view, text: lines.join("\n") };
    }
    case "show_grades": {
      const input = widgetContracts.show_grades.input.parse(args);
      const result = await service.run("grades", { ...withUnit(input.unit), mode: "graded", limit: 200 }) as { grades?: Array<GradeRow & { items?: GradesView["units"][number]["items"] }>; has_more?: boolean };
      const units = (result.grades ?? []).map(({ unit_id, code, total_grade, total_percentage, graded, total, items = [] }) => ({
        unit_id, code, total_grade, total_percentage, graded, total,
        items: items.map(({ id, name, type, grade, range, percentage }) => ({ id, name, type, grade, range, percentage })),
      }));
      const lines = units.flatMap(unit => [
        `${unit.code ?? unit.unit_id}: ${unit.graded} of ${unit.total} items marked${unit.total_grade ? `; course total ${unit.total_grade}${unit.total_percentage ? ` (${unit.total_percentage})` : ""}` : ""}.`,
        ...unit.items.map(item => `- ${item.name ?? "Item"}: ${item.grade ?? "-"}${item.range ? ` of ${item.range}` : ""}${item.percentage ? ` (${item.percentage})` : ""}${item.id ? `, activity ${item.id}` : ""}`),
      ]);
      if (result.has_more) lines.push("More marked items exist than the view shows; call grades with offset for the rest.");
      return { view: { kind: "grades", units }, text: lines.join("\n") || "No marked items yet." };
    }
    case "show_quiz_review": {
      const input = widgetContracts.show_quiz_review.input.parse(args);
      const { attempt } = await service.run("attempt", { attempt: input.attempt }) as { attempt: QuizView["attempt"] & { questions?: QuizView["attempt"]["questions"] } };
      const questions = attempt.questions ?? [];
      const view: QuizView = { kind: "quiz", attempt: { id: attempt.id, status: attempt.status, grade: attempt.grade, marks: attempt.marks, duration: attempt.duration, completed: attempt.completed, url: attempt.url, questions } };
      const lines = [
        `Quiz attempt ${attempt.id}: ${[attempt.status, attempt.grade && `grade ${attempt.grade}`, attempt.marks && `marks ${attempt.marks}`].filter(Boolean).join(", ") || "no summary"}; ${questions.length} questions.`,
        ...questions.map(q => `- Q${q.number}: ${[q.state, q.mark].filter(Boolean).join(", ") || "not marked"}`),
      ];
      return { view, text: lines.join("\n") };
    }
    case "show_unit": {
      const input = widgetContracts.show_unit.input.parse(args);
      const index = await service.run("unit", { unit: input.unit }) as { unit: { id: number; code?: string; name?: string; current_section?: { id: number; name?: string } }; sections?: Array<{ id: number; name?: string; hidden?: boolean }> };
      // The index already holds each top-level section's label; the activities come
      // from the same cached course fetch, nested children folded into their parent.
      const tree = new Map(sectionTree(await service.sections(index.unit.id)).map(({ section, children }) => [section.id, [section, ...children]]));
      const sections = (index.sections ?? []).map(({ id, name, hidden }) => ({
        id, name, hidden,
        activities: (tree.get(id) ?? []).flatMap(s => s.activities)
          .map(a => ({ id: a.id, name: a.name, type: a.modname, hidden: a.visible === false ? true : undefined })),
      }));
      const { id, code, name, current_section } = index.unit;
      const view: UnitView = { kind: "unit", unit: { id, code, name }, current: current_section?.id, sections };
      const count = sections.reduce((sum, s) => sum + s.activities.length, 0);
      const lines = [
        `${[code, name].filter(Boolean).join(" ")} (unit ${id}): ${sections.length} sections, ${count} activities${current_section?.name ? `; current section ${current_section.name}` : ""}.`,
        ...sections.flatMap(s => [
          `- ${s.name ?? `Section ${s.id}`} (${s.activities.length})`,
          ...s.activities.map(a => `  - ${a.name ?? "Activity"} (${[a.type, `id ${a.id}`].filter(Boolean).join(", ")})`),
        ]),
      ];
      return { view, text: lines.join("\n") };
    }
  }
}

function withUnit(unit: string | number | undefined): Record<string, unknown> {
  return unit === undefined ? {} : { unit };
}
