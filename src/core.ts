// The runtime-neutral Moodle client, published as `moodle-cli/core` for other Workers and Node
// programs. Pass the MoodleSession cookie; it resolves sesskey and the user itself.
export {
  createMoodleClientCore,
  MoodleClientCore,
  MoodleClientCoreApiError,
  MoodleClientCoreError,
  type MoodleClientCoreOptions,
  type MoodleSessionCookie,
} from "./moodle-client-core.js";
export type { Assignment, Course, CourseGrades, GradeItem, TodoItem, UserInfo } from "./models.js";
