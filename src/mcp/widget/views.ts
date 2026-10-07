// Payloads the server sends to the widget in a tool result's _meta. Types only, so
// both the server and the browser bundle can import them without pulling code across.

export interface DeadlineRow {
  id: number;
  activity_id?: number;
  name?: string;
  type?: string;
  unit_code?: string;
  due_at: number;
}

export interface DeadlinesView {
  kind: "deadlines";
  days: number;
  items: DeadlineRow[];
}

export interface GradeItem {
  id?: number;
  name?: string;
  type?: string;
  grade?: string;
  range?: string;
  percentage?: string;
}

export interface GradesView {
  kind: "grades";
  units: { unit_id: number; code?: string; total_grade?: string; total_percentage?: string; graded: number; total: number; items: GradeItem[] }[];
}

export interface QuizQuestion {
  number: number;
  type?: string;
  state?: string;
  mark?: string;
  text?: string;
  response?: string;
  correct?: string;
  feedback?: string;
}

export interface QuizView {
  kind: "quiz";
  attempt: { id: number; status?: string; grade?: string; marks?: string; duration?: string; completed?: string; url?: string; questions: QuizQuestion[] };
}

export interface OutlineActivity {
  id: number;
  name?: string;
  type?: string;
  hidden?: boolean;
}

export interface UnitView {
  kind: "unit";
  unit: { id: number; code?: string; name?: string };
  current?: number;
  sections: { id: number; name?: string; hidden?: boolean; activities: OutlineActivity[] }[];
}

export type WidgetView = DeadlinesView | GradesView | QuizView | UnitView;
