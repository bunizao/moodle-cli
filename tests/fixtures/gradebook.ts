import type { GradeItem } from "../../src/models.js";
import { parseGradeItem } from "../../src/parsers.js";
import { fixtureGateway } from "./intent-site.js";

export const feedback = "Detailed marker feedback. ".repeat(300);
export const item = (overrides: Partial<GradeItem>): GradeItem => parseGradeItem({ name: "Task", item_type: "Assignment", grade: "8", range: "0–10", percentage: "80%", weight: "", contribution: "", feedback, url: "", status: "", ...overrides });
export function gradebook() {
  const gateway = fixtureGateway();
  gateway.getGrades = async ({ courseId }) => ({
    course_id: courseId, course_name: "Algorithms", learner_name: "Alex", total_grade: "78", total_range: "0–100", total_percentage: "78%",
    items: [
      ...Array.from({ length: 43 }, (_, i) => item({ name: `Question ${i + 1}`, item_type: "Interactive content", grade: ["-", " – ", "—", "", "−"][i % 5], feedback: "", url: `https://moodle.example.edu/mod/h5pactivity/view.php?id=${courseId * 1000 + i + 1}` })),
      item({ name: "Assignment 1", item_type: "作业", grade: "0", percentage: "0%", url: `https://moodle.example.edu/mod/assign/view.php?id=${courseId * 1000 + 44}` }),
      item({ name: "Quiz 1", item_type: "测验", url: `https://moodle.example.edu/mod/quiz/view.php?id=${courseId * 1000 + 45}` }),
    ],
  });
  return gateway;
}
