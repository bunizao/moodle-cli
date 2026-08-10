import type {
  Activity,
  AlertNotification,
  AlertSummary,
  Course,
  ForumDiscussion,
  ForumPost,
  ForumPostAuthor,
  Section,
  TodoItem,
  UserInfo,
} from "./models.js";
import { htmlToStructuredContent, resolveUrl } from "./html-utils.js";

type AnyRecord = Record<string, unknown>;

export interface ParserSchema<T> {
  parse(value: unknown): T;
}

function schema<T>(parser: (value: unknown) => T): ParserSchema<T> {
  return { parse: parser };
}

export const UserInfoSchema = schema(parseUserInfo);
export const CourseSchema = schema(parseCourse);
export const CoursesSchema = schema(parseCourses);
export const ActivitySchema = schema(parseActivity);
export const SectionSchema = schema(parseSection);
export const CourseContentsSchema = schema(parseCourseContents);
export const TodoItemSchema = schema(parseTodoItem);

export function parseUserInfo(value: unknown): UserInfo {
  const data = asRecord(value);
  return {
    userid: numberValue(data.userid),
    username: stringValue(data.username),
    fullname: stringValue(data.fullname),
    sitename: stringValue(data.sitename),
    siteurl: stringValue(data.siteurl),
    lang: stringValue(data.lang),
  };
}

export function parseCourse(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)): Course {
  const data = asRecord(value);
  const course: Course = {
    id: numberValue(data.id),
    shortname: stringValue(data.shortname),
    fullname: stringValue(data.fullname),
    category: numberValue(data.category),
    visible: booleanValue(data.visible, true),
    startdate: numberValue(data.startdate),
  };
  const enddate = numberValue(data.enddate);
  if (enddate > nowSeconds) {
    course.enddate = enddate;
  }
  return course;
}

export function parseCourses(value: unknown): Course[] {
  return asArray(value).map((item) => parseCourse(item));
}

export function parseActivity(value: unknown): Activity {
  const data = asRecord(value);
  return {
    id: numberValue(data.id),
    name: stringValue(data.name),
    modname: stringValue(data.modname),
    url: stringValue(data.url),
    visible: booleanValue(data.visible, true),
    description: stringValue(data.description),
  };
}

export function parseSection(value: unknown): Section {
  const data = asRecord(value);
  return {
    id: numberValue(data.id),
    name: stringValue(data.name),
    section: numberValue(data.section),
    visible: booleanValue(data.visible, true),
    summary: stringValue(data.summary),
    activities: asArray(data.modules).map((item) => parseActivity(item)),
  };
}

export function parseCourseContents(value: unknown): Section[] {
  return asArray(value).map((item) => parseSection(item));
}

export function parseCourseFormatState(value: unknown, baseUrl: string): Section[] {
  const state = asRecord(parseJsonValue(value));
  const activities = new Map<string, Activity>();
  const activitiesBySection = new Map<string, Activity[]>();
  for (const item of asArray(state.cm)) {
    const data = asRecord(item);
    const id = numberValue(data.id);
    const sectionId = stringValue(data.sectionid);
    const module = stringValue(data.module)
      || stringValue(data.plugin).replace(/^mod_/u, "")
      || stringValue(data.modname).toLowerCase();
    const activity: Activity = {
      id,
      name: htmlText(data.name, baseUrl),
      modname: module.toLowerCase(),
      url: stringValue(data.url) ? resolveUrl(baseUrl, stringValue(data.url)) : "",
      visible: booleanValue(data.visible, true)
        && booleanValue(data.uservisible, true)
        && !booleanValue(data.stealth),
      description: htmlText(data.content ?? data.description, baseUrl),
    };
    activities.set(String(id), activity);
    const sectionActivities = activitiesBySection.get(sectionId) ?? [];
    sectionActivities.push(activity);
    activitiesBySection.set(sectionId, sectionActivities);
  }

  return asArray(state.section).map((item) => {
    const data = asRecord(item);
    const id = numberValue(data.id);
    const hasActivityList = Array.isArray(data.cmlist);
    const listedActivities = asArray(data.cmlist)
      .map((activityId) => activities.get(stringValue(activityId)))
      .filter((activity): activity is Activity => activity !== undefined);
    return {
      id,
      name: htmlText(data.title || data.rawtitle, baseUrl),
      section: numberValue(data.section ?? data.number),
      visible: booleanValue(data.visible, true),
      summary: htmlText(data.summary, baseUrl),
      activities: hasActivityList ? listedActivities : activitiesBySection.get(String(id)) ?? [],
    };
  });
}

export function flattenActivities(sections: Section[]): Activity[] {
  return sections.flatMap((section) => section.activities);
}

export function parseTodoItem(value: unknown): TodoItem {
  const data = asRecord(value);
  const course = asRecord(data.course);
  const action = asRecord(data.action);
  const progress = course.progress;
  return {
    id: numberValue(data.id),
    name: stringValue(data.name),
    activity_name: stringValue(data.activityname),
    modname: stringValue(data.modulename),
    course_id: numberValue(course.id),
    course_name: stringValue(course.fullname),
    due_at: numberValue(data.timesort) || numberValue(data.timestart),
    overdue: booleanValue(data.overdue),
    actionable: booleanValue(action.actionable),
    action_name: stringValue(action.name),
    action_url: stringValue(action.url),
    url: stringValue(data.url),
    event_type: stringValue(data.eventtype),
    course_progress: typeof progress === "number" ? progress : undefined,
  };
}

export function parseTodoItems(value: unknown): TodoItem[] {
  return asArray(value).map((item) => parseTodoItem(item));
}

export function parseAlertNotification(value: unknown): AlertNotification {
  const data = asRecord(value);
  return {
    id: numberValue(data.id),
    subject: stringValue(data.subject),
    short_subject: stringValue(data.shortenedsubject),
    event_type: stringValue(data.eventtype),
    component: stringValue(data.component),
    created_at: numberValue(data.timecreated),
    created_pretty: stringValue(data.timecreatedpretty),
    read: booleanValue(data.read),
    context_url: stringValue(data.contexturl),
    context_name: stringValue(data.contexturlname),
  };
}

export function parseAlertSummary(
  notificationsData: unknown,
  countsData: unknown,
  unreadCountsData: unknown,
): AlertSummary {
  const notificationsRecord = asRecord(notificationsData);
  const counts = asRecord(countsData);
  const unreadCounts = asRecord(unreadCountsData);
  const types = asRecord(counts.types);
  const unreadTypes = asRecord(unreadCounts.types);
  const notifications = asArray(notificationsRecord.notifications).map((item) => parseAlertNotification(item));

  return {
    notifications,
    notification_count: notifications.length,
    unread_notification_count: notifications.filter((notification) => !notification.read).length,
    starred_message_count: numberValue(counts.favourites),
    direct_message_count: numberValue(types["1"]),
    group_message_count: numberValue(types["2"]),
    self_message_count: numberValue(types["3"]),
    unread_starred_message_count: numberValue(unreadCounts.favourites),
    unread_direct_message_count: numberValue(unreadTypes["1"]),
    unread_group_message_count: numberValue(unreadTypes["2"]),
    unread_self_message_count: numberValue(unreadTypes["3"]),
  };
}

export function parseForumPostAuthor(value: unknown): ForumPostAuthor {
  const data = asRecord(value);
  const urls = asRecord(data.urls);
  return {
    id: numberValue(data.id),
    fullname: stringValue(data.fullname),
    profile_url: stringValue(urls.profile),
    profile_image_url: stringValue(urls.profileimage),
  };
}

export function parseForumPost(value: unknown, baseUrl = ""): ForumPost {
  const data = asRecord(value);
  const urls = asRecord(data.urls);
  const messageHtml = stringValue(data.message);
  const structured = htmlToStructuredContent(messageHtml, stringValue(urls.view || urls.discuss) || baseUrl);
  return {
    id: numberValue(data.id),
    discussion_id: numberValue(data.discussionid),
    subject: stringValue(data.subject),
    message_html: messageHtml,
    message_text: structured.text,
    image_urls: structured.image_urls,
    links: structured.links,
    tables: structured.tables,
    author: parseForumPostAuthor(data.author),
    parent_id: numberValue(data.parentid),
    time_created: numberValue(data.timecreated),
    time_modified: numberValue(data.timemodified),
    created_pretty: "",
    unread: booleanValue(data.unread),
    is_deleted: booleanValue(data.isdeleted),
    is_private_reply: booleanValue(data.isprivatereply),
    url: stringValue(urls.view || urls.viewisolated),
    reply_url: stringValue(urls.reply),
  };
}

export function parseForumDiscussion(value: unknown, discussionId: number, baseUrl = ""): ForumDiscussion {
  const data = asRecord(value);
  const posts = asArray(data.posts).map((item) => parseForumPost(item, baseUrl));
  return {
    id: discussionId,
    subject: posts[0]?.subject ?? "",
    course_id: numberValue(data.courseid),
    forum_id: numberValue(data.forumid),
    group_id: numberValue(data.groupid),
    group_name: stringValue(data.groupname),
    url: posts[0]?.url ? posts[0].url.split("#", 1)[0] : "",
    posts,
  };
}

export function asRecord(value: unknown): AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

export function booleanValue(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return Boolean(value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function htmlText(value: unknown, baseUrl: string): string {
  return htmlToStructuredContent(stringValue(value), baseUrl).text;
}
