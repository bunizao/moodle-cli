import { FORUM_DISCUSS_PATH, FORUM_VIEW_PATH, FUNC_GET_DISCUSSION_POSTS } from "./constants.js";
import type { Course, ForumActivityRef, ForumDiscussion, ForumDiscussionRef, Section } from "./models.js";
import { parseForumDiscussion } from "./parsers.js";
import {
  parseForumDiscussionGroupHtml,
  parseForumDiscussionHtml,
  parseForumDiscussionRefsHtml,
  parseForumGroupsHtml,
  parseForumViewCmidFromDiscussionHtml,
} from "./scraper.js";

export interface ForumAdapter {
  baseUrl: string;
  call: (functionName: string, args: Record<string, unknown>) => Promise<unknown>;
  getPage: (path: string, params: Record<string, string | number>) => Promise<string>;
  getCourses?: () => Promise<Course[]>;
  getCourseContents?: (courseId: number) => Promise<Section[]>;
}

export class ForumModule {
  readonly baseUrl: string;
  private readonly callMoodle: ForumAdapter["call"];
  private readonly loadPage: ForumAdapter["getPage"];
  private readonly loadCourses?: () => Promise<Course[]>;
  private readonly loadCourseContents?: (courseId: number) => Promise<Section[]>;
  private readonly forumDiscussionCache = new Map<number, ForumDiscussion>();
  private readonly groupResolved = new Set<number>();
  private readonly forumDiscussionRefsCache = new Map<number, ForumDiscussionRef[]>();
  // The forum view page answers both "what type is this forum" and "which
  // discussions does it list"; load it once per forum.
  private readonly forumViewCache = new Map<number, Promise<string>>();

  constructor(options: ForumAdapter) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.callMoodle = options.call;
    this.loadPage = options.getPage;
    this.loadCourses = options.getCourses;
    this.loadCourseContents = options.getCourseContents;
  }

  // The posts service does not name the discussion's group; that costs a page load,
  // so callers that never show groups (announcements, thread pages) opt out.
  async getForumDiscussion(discussionId: number, options: { group?: boolean } = {}): Promise<ForumDiscussion> {
    const wantGroup = options.group !== false;
    const cached = this.forumDiscussionCache.get(discussionId);
    if (cached) {
      if (wantGroup && cached.group_id <= 0 && !this.groupResolved.has(discussionId)) await this.resolveGroup(cached);
      return cached;
    }

    try {
      const data = await this.callMoodle(FUNC_GET_DISCUSSION_POSTS, {
        discussionid: discussionId,
        sortby: "created",
        sortdirection: "ASC",
        includeinlineattachments: true,
      });
      const discussion = parseForumDiscussion(data, discussionId, this.baseUrl);
      if (wantGroup && discussion.group_id <= 0) await this.resolveGroup(discussion);
      this.forumDiscussionCache.set(discussionId, discussion);
      return discussion;
    } catch (error) {
      if (!shouldFallbackForumAjax(error)) {
        throw error;
      }
    }

    const html = await this.loadPage(FORUM_DISCUSS_PATH, { d: discussionId });
    const discussion = parseForumDiscussionHtml(html, this.baseUrl, discussionId);
    this.groupResolved.add(discussionId);
    this.forumDiscussionCache.set(discussionId, discussion);
    return discussion;
  }

  private async resolveGroup(discussion: ForumDiscussion): Promise<void> {
    this.groupResolved.add(discussion.id);
    const html = await this.loadPage(FORUM_DISCUSS_PATH, { d: discussion.id }).catch(() => "");
    if (!html) return;
    const [groupId, groupName] = parseForumDiscussionGroupHtml(html);
    discussion.group_id = groupId;
    discussion.group_name = groupName;
  }

  async getForumViewCmid(discussionId: number): Promise<number | null> {
    const html = await this.loadPage(FORUM_DISCUSS_PATH, { d: discussionId });
    return parseForumViewCmidFromDiscussionHtml(html);
  }

  async getForumDiscussionRefs(forumCmid: number): Promise<ForumDiscussionRef[]> {
    const cached = this.forumDiscussionRefsCache.get(forumCmid);
    if (cached) {
      return cached;
    }

    const html = await this.forumViewHtml(forumCmid);
    const groups = parseForumGroupsHtml(html);
    const refs = groups.length ? [] : parseForumDiscussionRefsHtml(html, this.baseUrl);
    const seenIds = new Set(refs.map((ref) => ref.id));

    for (const [groupId, groupName] of groups) {
      const groupHtml = await this.loadPage(FORUM_VIEW_PATH, { id: forumCmid, group: groupId });
      for (const ref of parseForumDiscussionRefsHtml(groupHtml, this.baseUrl)) {
        if (seenIds.has(ref.id)) {
          continue;
        }
        seenIds.add(ref.id);
        refs.push({ ...ref, group_id: groupId, group_name: groupName });
      }
    }

    this.forumDiscussionRefsCache.set(forumCmid, refs);
    return refs;
  }

  private forumViewHtml(forumCmid: number): Promise<string> {
    const pending = this.forumViewCache.get(forumCmid) ?? this.loadPage(FORUM_VIEW_PATH, { id: forumCmid });
    this.forumViewCache.set(forumCmid, pending);
    pending.catch(() => this.forumViewCache.delete(forumCmid));
    return pending;
  }

  async isNewsForum(forumCmid: number): Promise<boolean> {
    return /\bforumtype-news\b|data-forumtype=["']news["']/u.test(await this.forumViewHtml(forumCmid));
  }

  private async getCourseForums(courseId: number, courseName = ""): Promise<ForumActivityRef[]> {
    if (!this.loadCourseContents) {
      throw new Error("getCourseContents loader is required to list course forums");
    }
    const sections = await this.loadCourseContents(courseId);
    return sections.flatMap((section) =>
      section.activities
        .filter((activity) => activity.modname === "forum")
        .map((activity) => ({
          id: activity.id,
          name: activity.name,
          course_id: courseId,
          course_name: courseName,
          url: activity.url,
        })),
    );
  }

  async getForums(courseId?: number): Promise<ForumActivityRef[]> {
    if (courseId !== undefined) {
      const courseName = await this.courseName(courseId);
      return this.getCourseForums(courseId, courseName);
    }
    if (!this.loadCourses) {
      throw new Error("getCourses loader is required to list all forums");
    }
    // Units are independent; list a few at a time instead of one after another.
    const courses = await this.loadCourses();
    const forums: ForumActivityRef[] = [];
    for (let index = 0; index < courses.length; index += 4) {
      const batch = await Promise.all(courses.slice(index, index + 4).map((course) => this.getCourseForums(course.id, course.fullname || course.shortname)));
      forums.push(...batch.flat());
    }
    return forums;
  }

  private async courseName(courseId: number): Promise<string> {
    if (!this.loadCourses) {
      return "";
    }
    const course = (await this.loadCourses()).find((item) => item.id === courseId);
    return course ? course.fullname || course.shortname : "";
  }
}

function shouldFallbackForumAjax(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const code = typeof error.moodleErrorCode === "string" ? error.moodleErrorCode : "";
  return (
    code === "servicenotavailable" ||
    code === "accessexception" ||
    (error instanceof Error && error.message.includes("Web service is not available"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
