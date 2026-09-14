import { parse } from "node-html-parser";

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

export interface FileInput {
  source: number | string;
}

export interface MoodleFile {
  name: string;
  mimeType: string;
  bytes: number;
  uri: string;
  blob: string;
}

export const MAX_MCP_FILE_BYTES = 16 * 1024 * 1024;

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
  getFile(input: FileInput): Promise<MoodleFile>;
}

export interface MoodleClientPort {
  readonly baseUrl: string;
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
  requestAbsolute(url: string, init?: RequestInit): Promise<Response>;
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
    async getFile({ source }) {
      let target = await resolveFileTarget(client, source);
      let response = await client.requestAbsolute(target.url);
      if (isHtml(response)) {
        const html = await response.text();
        if (looksLikeLoginPage(html)) throw fileAuthenticationRequired();
        const links = resourceLinks(html, target.url);
        if (links.length !== 1) {
          const code = links.length ? "MOODLE_FILE_SOURCE_AMBIGUOUS" : "MOODLE_FILE_NOT_FOUND";
          throw new MoodleGatewayError(code, "The Moodle resource did not resolve to exactly one file.");
        }
        const resolved = await resolveFileTarget(client, links[0].url);
        target = { ...resolved, name: target.name || links[0].name || resolved.name };
        response = await client.requestAbsolute(target.url);
        if (isHtml(response)) {
          if (looksLikeLoginPage(await response.text())) throw fileAuthenticationRequired();
          throw new MoodleGatewayError("MOODLE_FILE_NOT_FOUND", "Moodle did not return a downloadable file.");
        }
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_MCP_FILE_BYTES) {
        throw fileTooLarge();
      }
      const content = await readBoundedBody(response, MAX_MCP_FILE_BYTES);
      const name = safeFilename(contentDispositionFilename(response.headers.get("content-disposition")))
        ?? safeFilename(target.name)
        ?? safeFilename(urlFilename(response.url || target.url));
      if (!name) {
        throw new MoodleGatewayError("MOODLE_FILE_NAME_MISSING", "Moodle did not provide a safe filename.");
      }

      return {
        name,
        mimeType: contentType(response),
        bytes: content.byteLength,
        uri: publicFileUrl(response.url || target.url),
        blob: encodeBase64(content),
      };
    },
  };
}

async function resolveFileTarget(
  client: MoodleClientPort,
  rawSource: number | string,
): Promise<{ url: string; name?: string }> {
  const source = String(rawSource).trim();
  if (/^\d+$/u.test(source)) {
    const activityId = Number(source);
    if (!Number.isSafeInteger(activityId) || activityId < 1) throw invalidFileSource();
    return validateFileTarget(client, await fileFromActivity(client, activityId));
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw invalidFileSource();
  }
  const site = new URL(client.baseUrl);
  const sitePath = site.pathname.replace(/\/$/u, "");
  if (url.origin !== site.origin) throw invalidFileSource();
  if (url.pathname === `${sitePath}/mod/resource/view.php`) {
    const activityId = Number(url.searchParams.get("id"));
    if (!Number.isSafeInteger(activityId) || activityId < 1) throw invalidFileSource();
    return validateFileTarget(client, await fileFromActivity(client, activityId));
  }
  if (!url.pathname.startsWith(`${sitePath}/pluginfile.php/`)) throw invalidFileSource();
  return { url: url.toString(), name: urlFilename(url.toString()) };
}

function validateFileTarget<T extends { url: string }>(client: MoodleClientPort, target: T): T {
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw invalidFileSource();
  }
  const site = new URL(client.baseUrl);
  const sitePath = site.pathname.replace(/\/$/u, "");
  const supportedPath = url.pathname === `${sitePath}/mod/resource/view.php`
    || url.pathname.startsWith(`${sitePath}/pluginfile.php/`);
  if (url.origin !== site.origin || !supportedPath) throw invalidFileSource();
  return target;
}

async function fileFromActivity(
  client: MoodleClientPort,
  activityId: number,
): Promise<{ url: string; name?: string }> {
  const activity = await client.getActivity(activityId);
  if (activity.type !== "resource" || !("file_entries" in activity) || !Array.isArray(activity.file_entries)) {
    throw new MoodleGatewayError(
      "MOODLE_FILE_SOURCE_INVALID",
      `Activity ${activityId} is not a downloadable resource.`,
    );
  }
  if (activity.file_entries.length !== 1) {
    if (activity.file_entries.length === 0) {
      const resource = activity as typeof activity & { target_name?: string; target_url?: string; url?: string };
      const url = resource.target_url || resource.url;
      if (url) return { url, name: resource.target_name || undefined };
    }
    throw new MoodleGatewayError(
      "MOODLE_FILE_SOURCE_AMBIGUOUS",
      `Activity ${activityId} did not resolve to exactly one file. Inspect file_entries and request one URL.`,
    );
  }
  const [entry] = activity.file_entries;
  return { url: entry.url, name: entry.name };
}

function resourceLinks(html: string, baseUrl: string): Array<{ name: string; url: string }> {
  const root = parse(html);
  const entries = root
    .querySelectorAll(".resourceworkaround a[href], .resourcecontent a[href], a.resourceworkaround[href]")
    .map((link) => ({
      name: link.textContent.trim(),
      url: new URL(link.getAttribute("href") ?? "", baseUrl).toString(),
    }))
    .filter((entry) => entry.url !== baseUrl);
  return entries.filter((entry, index) => entries.findIndex((candidate) => candidate.url === entry.url) === index);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw fileTooLarge();
    }
    chunks.push(value);
  }
  const content = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function invalidFileSource(): MoodleGatewayError {
  return new MoodleGatewayError(
    "MOODLE_FILE_SOURCE_INVALID",
    "Use a positive resource activity ID, a same-site resource URL, or a same-site pluginfile URL.",
  );
}

function fileTooLarge(): MoodleGatewayError {
  return new MoodleGatewayError(
    "MOODLE_FILE_TOO_LARGE",
    `Moodle files returned through MCP cannot exceed ${MAX_MCP_FILE_BYTES / 1024 / 1024} MiB.`,
  );
}

function fileAuthenticationRequired(): MoodleGatewayError {
  return new MoodleGatewayError(
    "MOODLE_AUTH_REQUIRED",
    "Moodle returned a login page instead of the requested file.",
  );
}

function isHtml(response: Response): boolean {
  if (/\battachment\b/iu.test(response.headers.get("content-disposition") ?? "")) return false;
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  return type.includes("text/html") || type.includes("application/xhtml+xml");
}

function looksLikeLoginPage(html: string): boolean {
  const root = parse(html);
  return root.querySelector('form[action*="/login/"], input[name="password"], #page-login-index') !== null
    || /<title>\s*(?:log in|login)/iu.test(html);
}

function contentType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
}

function contentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const extended = value.match(/filename\*\s*=\s*([^;]+)/iu)?.[1]?.trim().replace(/^"|"$/gu, "");
  if (extended) {
    const encoded = extended.replace(/^[^']*'[^']*'/u, "");
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  const quoted = value.match(/filename\s*=\s*"((?:\\.|[^"])*)"/iu)?.[1];
  if (quoted !== undefined) return quoted.replace(/\\([\\"])/gu, "$1");
  return value.match(/filename\s*=\s*([^;]+)/iu)?.[1]?.trim();
}

function urlFilename(value: string): string | undefined {
  try {
    const encoded = new URL(value).pathname.split("/").at(-1) ?? "";
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  } catch {
    return undefined;
  }
}

function safeFilename(value: string | undefined): string | undefined {
  const name = value?.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return name && name !== "." && name !== ".." ? name : undefined;
}

function publicFileUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key !== "forcedownload" && key !== "download") url.searchParams.delete(key);
  }
  return url.toString();
}

function encodeBase64(content: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < content.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...content.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}
