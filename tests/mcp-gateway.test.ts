import { describe, expect, it } from "vitest";

import { createMoodleGateway, type MoodleClientPort } from "../src/mcp/gateway.js";

describe("Moodle gateway", () => {
  it("adapts the existing client surface to runtime-neutral Moodle operations", async () => {
    const client = fakeClient();
    const gateway = createMoodleGateway(client);

    await expect(gateway.getUser()).resolves.toMatchObject({ userid: 7, fullname: "Ada Lovelace" });
    await expect(gateway.getOverview({ todoLimit: 3, todoDays: 14, alertsLimit: 2 })).resolves.toMatchObject({
      user: { userid: 7 },
    });
    await expect(gateway.getCourse({ courseId: 101 })).resolves.toMatchObject({
      course: { id: 101, shortname: "COMP101" },
      sections: [{ id: 1, name: "Week 1" }],
    });
    await expect(gateway.listActivities({ courseId: 101 })).resolves.toEqual([
      expect.objectContaining({ id: 501, modname: "assign" }),
    ]);
    await expect(gateway.getActivity({ activityId: 501 })).resolves.toMatchObject({ id: 501, type: "assign" });
    await expect(gateway.getGrades({ courseId: 101 })).resolves.toMatchObject({ course_id: 101, total_grade: "80" });
    await expect(gateway.listForums({ courseId: 101 })).resolves.toEqual([
      expect.objectContaining({ id: 601, course_id: 101 }),
    ]);
    await expect(gateway.searchForums({ query: "exam", courseId: 101, forumId: 601, limit: 5 })).resolves.toEqual([
      expect.objectContaining({ discussion_id: 701, snippet: "Exam details" }),
    ]);
    await expect(gateway.getThread({ discussionId: 701 })).resolves.toMatchObject({ id: 701, subject: "Exam" });
  });

  it("reports a missing course at the gateway boundary", async () => {
    const gateway = createMoodleGateway({
      ...fakeClient(),
      getCourses: async () => [],
    });

    await expect(gateway.getCourse({ courseId: 404 })).rejects.toMatchObject({
      code: "MOODLE_COURSE_NOT_FOUND",
    });
  });
});

function fakeClient(): MoodleClientPort {
  const user = {
    userid: 7,
    username: "ada",
    fullname: "Ada Lovelace",
    sitename: "Example Moodle",
    siteurl: "https://moodle.example.edu",
  };
  const course = {
    id: 101,
    shortname: "COMP101",
    fullname: "Computing",
    category: 1,
    visible: true,
    startdate: 1,
  };
  const activity = {
    id: 501,
    name: "Assignment 1",
    modname: "assign",
    url: "https://moodle.example.edu/mod/assign/view.php?id=501",
    visible: true,
    description: "",
  };
  const section = { id: 1, name: "Week 1", section: 1, visible: true, summary: "", activities: [activity] };

  return {
    getSiteInfo: async () => user,
    getOverview: async () => ({ user, courses: [course], todo: [], errors: [] }),
    getCourses: async () => [course],
    getCourseContents: async () => [section],
    getActivities: async () => [activity],
    getActivity: async () => ({
      id: 501,
      name: "Assignment 1",
      course_id: 101,
      course_name: "Computing",
      section_name: "Week 1",
      due_pretty: "Tomorrow",
      submission_status: "Not submitted",
      grading_status: "Not graded",
      time_remaining: "1 day",
      grade: "-",
      url: activity.url,
      type: "assign",
    }),
    getCourseGrades: async () => ({
      course_id: 101,
      course_name: "Computing",
      learner_name: "Ada Lovelace",
      total_grade: "80",
      total_range: "0-100",
      total_percentage: "80%",
      items: [],
    }),
    getForums: async () => [{
      id: 601,
      name: "Announcements",
      course_id: 101,
      course_name: "Computing",
      url: "https://moodle.example.edu/mod/forum/view.php?id=601",
    }],
    searchForumContent: async () => [{
      course_id: 101,
      course_name: "Computing",
      forum_id: 601,
      forum_name: "Announcements",
      group_id: 0,
      group_name: "",
      discussion_id: 701,
      discussion_subject: "Exam",
      post_id: 702,
      author_name: "Teacher",
      matched_in: "post_body",
      snippet: "Exam details",
      unread: true,
      time_created: 1,
      url: "https://moodle.example.edu/mod/forum/discuss.php?d=701",
    }],
    getForumDiscussion: async () => ({
      id: 701,
      subject: "Exam",
      course_id: 101,
      forum_id: 601,
      group_id: 0,
      group_name: "",
      url: "https://moodle.example.edu/mod/forum/discuss.php?d=701",
      posts: [],
    }),
  };
}
