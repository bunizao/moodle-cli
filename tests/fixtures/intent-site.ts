import type { Course, Section } from "../../src/models.js";
import type { MoodleGateway } from "../../src/mcp/gateway.js";
export const units: Course[] = [
  { id: 1, shortname: "DB240", fullname: "Databases", startdate: 1788134400, category: 0, visible: true },
  { id: 2, shortname: "algo-2", fullname: "Algorithms", startdate: 1788134400, category: 0, visible: true },
  { id: 3, shortname: "STATS", fullname: "Statistics", startdate: 1788134400, category: 0, visible: true },
  { id: 4, shortname: "", fullname: "Ethics in Computing", startdate: 1788134400, category: 0, visible: true },
];
export function sections(label = "Week", unitId = 2): Section[] {
  return [7, 17].map((n, index) => ({ id: unitId * 1000 + index, section: index + 1, name: `${label} ${n}`, visible: true, summary: "", current: index === 0, activities: [
    { id: unitId * 100 + index * 10, name: `${label} ${n} Lecture slides`, modname: "resource", description: "", url: `https://moodle.example.edu/mod/resource/view.php?id=${unitId * 100 + index * 10}`, visible: true, file_entries: [{ name: "slides.pdf", url: "https://moodle.example.edu/pluginfile.php/1/slides.pdf", requires_authentication: true }] },
    { id: unitId * 100 + index * 10 + 1, name: "Mini Test", modname: "assign", description: "", url: "", visible: true },
    { id: unitId * 100 + index * 10 + 2, name: "Lecture slides", modname: "label", description: "", url: "", visible: true },
  ] }));
}
export const siteUser = { userid: 7, username: "alex", fullname: "Alex", sitename: "Moodle", siteurl: "https://moodle.example.edu", timezone: "Europe/Berlin" };
export function fixtureGateway(): MoodleGateway {
  const todos = units.map((c, index) => ({ id: index + 1, name: "Mini Test is due", activity_name: "Mini Test", modname: "assign", course_id: c.id, course_name: c.fullname, due_at: 1789826100, overdue: false, actionable: false, action_name: "View", action_url: "", url: `https://moodle.example.edu/mod/assign/view.php?id=${c.id * 100 + 1}`, event_type: "due" }));
  return {
    getUser: async () => siteUser,
    listCourses: async () => units,
    getCourse: async ({ courseId }) => ({ course: units.find(c => c.id === courseId)!, sections: sections("Week", courseId) }),
    listActivities: async ({ courseId }) => sections("Week", courseId).flatMap(s => s.activities),
    getOverview: async () => ({ user: siteUser, courses: units, todo: todos, errors: [] }),
    getActivity: async ({ activityId }) => ({ id: activityId, name: "Mini Test", type: "assign", course_id: Math.floor(activityId / 100), course_name: "Algorithms", section_name: "Week 7", due_pretty: "", submission_status: "Not submitted", grading_status: "Not graded", time_remaining: "", grade: "", url: `https://moodle.example.edu/mod/assign/view.php?id=${activityId}` }),
    getGrades: async ({ courseId }) => ({ course_id: courseId, course_name: "Algorithms", learner_name: "Alex", total_grade: "", total_range: "", total_percentage: "", items: [ { name: "Mini Test", item_type: "assign", grade: "-", range: "0–10", percentage: "", weight: "", contribution: "", feedback: "", url: "", status: "" }, { name: "Quiz", item_type: "quiz", grade: "8", range: "0–10", percentage: "80%", weight: "", contribution: "", feedback: "Well done", url: "", status: "" }] }),
    listForums: async ({ courseId }) => [{ id: 50, name: "News", course_id: courseId ?? 2, course_name: "Algorithms", url: "https://moodle.example.edu/mod/forum/view.php?id=50" }],
    listNewsForums: async (courseId) => (courseId === undefined ? units : units.filter(c => c.id === courseId)).map(c => ({ id: 48 + c.id, name: "News", course_id: c.id, course_name: c.fullname, url: `https://moodle.example.edu/mod/forum/view.php?id=${48 + c.id}` })),
    listThreads: async () => [{ id: 60, subject: "Assignment released", group_id: 0, group_name: "", url: "https://moodle.example.edu/mod/forum/discuss.php?d=60" }],
    searchForums: async () => [{ course_id: 2, course_name: "Algorithms", forum_id: 50, forum_name: "News", group_id: 0, group_name: "", discussion_id: 60, discussion_subject: "Assignment released", post_id: 70, author_name: "Sam", matched_in: "post_body", snippet: "Read the assignment brief.", unread: true, time_created: 1789401600, url: "https://moodle.example.edu/mod/forum/discuss.php?d=60#p70" }],
    getThread: async () => ({ id: 60, subject: "Assignment released", course_id: 2, forum_id: 50, group_id: 0, group_name: "", url: "https://moodle.example.edu/mod/forum/discuss.php?d=60", posts: Array.from({ length: 25 }, (_, i) => ({ id: 70 + i, discussion_id: 60, subject: i ? "Re: Assignment released" : "Assignment released", message_html: "<p>Read the assignment brief.</p>", message_text: "Read the assignment brief.", image_urls: [], links: [], tables: [], author: { id: 8, fullname: "Sam", profile_url: "", profile_image_url: "" }, parent_id: i ? 70 : 0, time_created: 1789401600 + i, time_modified: 0, created_pretty: "", unread: false, is_deleted: false, is_private_reply: false, url: "", reply_url: "" })) }),
    getFile: async () => ({ name: "slides.pdf", mimeType: "application/pdf", bytes: 6, uri: "https://moodle.example.edu/pluginfile.php/1/slides.pdf", blob: "c2xpZGVz" }),
  };
}
export const intentCalls = [
  ["home", {}], ["due", { unit: "algo-2" }], ["units", {}], ["unit", { unit: "algo-2" }],
  ["find", { query: "week 7 slides", unit: "algo-2" }], ["item", { ref: "algo-2 week 7 mini test" }],
  ["grades", {}], ["news", { unit: "algo-2" }], ["thread", { discussion_id: 60, limit: 1 }],
  ["search_forums", { query: "assignment" }], ["file", { ref: "algo-2 week 7 slides" }],
] as const;
