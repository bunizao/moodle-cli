import type {
  Activity,
  ActivityDetail,
  Course,
  CourseGrades,
  ForumActivityRef,
  ForumDiscussion,
  ForumSearchHit,
  Overview,
  Section,
  UserInfo,
} from "../models.js";

export interface OverviewInput {
  todoLimit?: number;
  todoDays?: number;
  alertsLimit?: number;
}

export interface CourseInput {
  courseId: number;
}

export interface CourseDetail {
  course: Course;
  sections: Section[];
}

export interface ActivityListInput extends CourseInput {
  limit?: number;
}

export interface ActivityInput {
  activityId: number;
}

export interface GradeInput extends CourseInput {}

export interface ForumListInput {
  courseId?: number;
  limit?: number;
}

export interface ForumSearchInput {
  query: string;
  limit?: number;
  courseId?: number;
  forumId?: number;
  includePostText?: boolean;
  unreadOnly?: boolean;
  sortBy?: "relevance" | "recent";
  maxForums?: number;
  maxDiscussionsPerForum?: number;
}

export interface ThreadInput {
  discussionId: number;
}

export interface MoodleGateway {
  getUser(): Promise<UserInfo>;
  getOverview(input: OverviewInput): Promise<Overview>;
  listCourses(): Promise<Course[]>;
  getCourse(input: CourseInput): Promise<CourseDetail>;
  listActivities(input: ActivityListInput): Promise<Activity[]>;
  getActivity(input: ActivityInput): Promise<ActivityDetail & { type: string }>;
  getGrades(input: GradeInput): Promise<CourseGrades>;
  listForums(input: ForumListInput): Promise<ForumActivityRef[]>;
  searchForums(input: ForumSearchInput): Promise<ForumSearchHit[]>;
  getThread(input: ThreadInput): Promise<ForumDiscussion>;
}

export interface MoodleClientPort {
  getSiteInfo(): Promise<UserInfo>;
  getOverview(todoLimit?: number, todoDays?: number, alertsLimit?: number): Promise<Overview>;
  getCourses(): Promise<Course[]>;
  getCourseContents(courseId: number): Promise<Section[]>;
  getActivities(courseId: number): Promise<Activity[]>;
  getActivity(activityId: number): Promise<ActivityDetail & { type: string }>;
  getCourseGrades(courseId: number): Promise<CourseGrades>;
  getForums(courseId?: number): Promise<ForumActivityRef[]>;
  searchForumContent(options: {
    query: string;
    limit?: number;
    courseId?: number;
    forumCmid?: number;
    includePostText?: boolean;
    unreadOnly?: boolean;
    sortBy?: "relevance" | "recent";
    maxForums?: number;
    maxDiscussionsPerForum?: number;
  }): Promise<ForumSearchHit[]>;
  getForumDiscussion(discussionId: number): Promise<ForumDiscussion>;
}

export class MoodleGatewayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MoodleGatewayError";
    this.code = code;
  }
}

export function createMoodleGateway(client: MoodleClientPort): MoodleGateway {
  return {
    getUser: () => client.getSiteInfo(),
    getOverview: (input) => client.getOverview(input.todoLimit, input.todoDays, input.alertsLimit),
    listCourses: () => client.getCourses(),
    async getCourse({ courseId }) {
      const [courses, sections] = await Promise.all([
        client.getCourses(),
        client.getCourseContents(courseId),
      ]);
      const course = courses.find((item) => item.id === courseId);
      if (!course) {
        throw new MoodleGatewayError("MOODLE_COURSE_NOT_FOUND", `Course ${courseId} was not found.`);
      }
      return { course, sections };
    },
    async listActivities({ courseId, limit }) {
      const activities = await client.getActivities(courseId);
      return limit === undefined ? activities : activities.slice(0, limit);
    },
    getActivity: ({ activityId }) => client.getActivity(activityId),
    getGrades: ({ courseId }) => client.getCourseGrades(courseId),
    async listForums({ courseId, limit }) {
      const forums = await client.getForums(courseId);
      return limit === undefined ? forums : forums.slice(0, limit);
    },
    searchForums: ({ forumId, ...input }) => client.searchForumContent({ ...input, forumCmid: forumId }),
    getThread: ({ discussionId }) => client.getForumDiscussion(discussionId),
  };
}
