import { z } from "zod";
import {
  AJAX_SERVICE_PATH,
  ASSIGN_VIEW_PATH,
  COURSE_PATH,
  DASHBOARD_PATH,
  FOLDER_VIEW_PATH,
  FUNC_GET_ACTION_EVENTS,
  FUNC_GET_CONVERSATION_COUNTS,
  FUNC_GET_COURSE_CONTENTS,
  FUNC_GET_COURSE_MODULE,
  FUNC_GET_COURSES,
  FUNC_GET_COURSES_BY_TIMELINE,
  FUNC_GET_POPUP_NOTIFICATIONS,
  FUNC_GET_SITE_INFO,
  FUNC_GET_UNREAD_CONVERSATION_COUNTS,
  GRADE_REPORT_INDEX_PATH,
  GRADE_REPORT_OVERVIEW_PATH,
  GRADE_REPORT_PATH,
  PAGE_VIEW_PATH,
  QUIZ_VIEW_PATH,
  RESOURCE_VIEW_PATH,
  URL_VIEW_PATH,
} from "./constants.js";
import { ForumModule } from "./moodle-forum-core.js";
import { searchForumContent as searchForumModule } from "./moodle-forum-search-core.js";
import type {
  AlertSummary,
  ActivityDetail,
  Assignment,
  Course,
  CourseGrades,
  Folder,
  ForumActivityRef,
  ForumDiscussion,
  ForumDiscussionRef,
  ForumSearchHit,
  Link,
  Overview,
  Page,
  PageContext,
  Quiz,
  Resource,
  Section,
  TodoItem,
  UserInfo,
} from "./models.js";
import {
  parseAlertSummary,
  parseCourseContents,
  parseCourses,
  parseTodoItems,
  parseUserInfo,
} from "./parsers.js";
import {
  hasCourseGradesHtml,
  parseAssignmentHtml,
  parseCourseContentsHtml,
  parseCourseGradesHtml,
  parseCourseGradesUrl,
  parseCourseIdFromPageHtml,
  parseCourseSectionNumbers,
  parseFolderHtml,
  parseGradeOverviewRows,
  parseLinkHtml,
  parsePageContext,
  parsePageHtml,
  parseQuizHtml,
  parseResourceHtml,
} from "./scraper.js";

export interface AjaxCall {
  methodname: string;
  args?: Record<string, unknown>;
}

export type AjaxBatchResult =
  | { ok: true; data: unknown }
  | { ok: false; error: MoodleApiErrorLike };

export interface MoodleApiErrorLike extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly moodleErrorCode?: string;
}

export interface MoodleClientErrorAdapter {
  api(message: string, moodleErrorCode?: string): MoodleApiErrorLike;
  notFound(message: string): Error;
  isApi(error: unknown): error is MoodleApiErrorLike;
  isLoginRequired(error: unknown): boolean;
}

export class MoodleClientCoreError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "MoodleClientCoreError";
    this.code = code;
    this.hint = hint;
  }
}

export class MoodleClientCoreApiError extends MoodleClientCoreError implements MoodleApiErrorLike {
  readonly moodleErrorCode?: string;

  constructor(message: string, moodleErrorCode?: string) {
    const auth = isLoginErrorCode(moodleErrorCode);
    const notFound = ["invalidrecord", "invalidcoursemodule"].includes(moodleErrorCode ?? "")
      || /^HTTP 404\b/.test(message);
    super(
      auth ? "auth" : notFound ? "not_found" : "upstream",
      message,
      auth ? "Refresh the Moodle session." : undefined,
    );
    this.name = "MoodleClientCoreApiError";
    this.moodleErrorCode = moodleErrorCode;
  }
}

const DEFAULT_ERROR_ADAPTER: MoodleClientErrorAdapter = {
  api: (message, moodleErrorCode) => new MoodleClientCoreApiError(message, moodleErrorCode),
  notFound: (message) => new MoodleClientCoreError("not_found", message),
  isApi: (error): error is MoodleApiErrorLike => error instanceof MoodleClientCoreApiError,
  isLoginRequired: (error) => error instanceof MoodleClientCoreApiError && isLoginErrorCode(error.moodleErrorCode),
};

export interface MoodleSessionCookie {
  name: string;
  value: string;
}

export interface MoodleClientSessionSnapshot {
  baseUrl: string;
  cookieName: string;
  cookieValue: string;
  sesskey: string;
  userid: number;
}

export interface MoodleClientCoreOptions {
  fetchImpl?: typeof fetch;
  cookie: MoodleSessionCookie;
  pageContext?: PageContext;
  sesskey?: string;
  userid?: number;
  userInfo?: UserInfo;
  errorAdapter?: MoodleClientErrorAdapter;
  clearSessionCache?: () => Promise<void>;
  writeSessionCache?: (session: MoodleClientSessionSnapshot) => Promise<void>;
  onLoginRequired?: () => Promise<{ cookie: MoodleSessionCookie; pageContext: PageContext }>;
}

const AjaxEnvelopeSchema = z.array(
  z.object({
    error: z.boolean().optional(),
    data: z.unknown().optional(),
    exception: z
      .object({
        message: z.string().optional(),
        errorcode: z.string().optional(),
      })
      .passthrough()
      .optional(),
  }).passthrough(),
);

export class MoodleClientCore {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch;
  private cookie: MoodleSessionCookie;
  private sesskey: string | null;
  private userid: number | null;
  private userInfo: UserInfo | null;
  private clearSessionCache?: () => Promise<void>;
  private writeSessionCache?: (session: MoodleClientSessionSnapshot) => Promise<void>;
  private readonly errors: MoodleClientErrorAdapter;
  private onLoginRequired?: () => Promise<{ cookie: MoodleSessionCookie; pageContext: PageContext }>;
  private retryingLogin = false;
  private readonly forum: ForumModule;

  constructor(baseUrl: string, options: MoodleClientCoreOptions | string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const resolvedOptions: MoodleClientCoreOptions = typeof options === "string"
      ? { cookie: { name: "MoodleSession", value: options } }
      : options;
    this.fetchImpl = resolvedOptions.fetchImpl ?? fetch;
    this.cookie = resolvedOptions.cookie;
    this.sesskey = resolvedOptions.pageContext?.sesskey ?? resolvedOptions.sesskey ?? null;
    this.userid = resolvedOptions.pageContext?.user_info.userid ?? resolvedOptions.userid ?? null;
    this.userInfo = resolvedOptions.pageContext?.user_info
      ?? resolvedOptions.userInfo
      ?? (this.userid ? placeholderUserInfo(this.baseUrl, this.userid) : null);
    this.clearSessionCache = resolvedOptions.clearSessionCache;
    this.writeSessionCache = resolvedOptions.writeSessionCache;
    this.errors = resolvedOptions.errorAdapter ?? DEFAULT_ERROR_ADAPTER;
    this.onLoginRequired = resolvedOptions.onLoginRequired;
    this.forum = new ForumModule({
      baseUrl: this.baseUrl,
      call: async (functionName, args) => {
        await this.ensureSession();
        return this.call(functionName, args);
      },
      getPage: (path, params) => this.get(path, params),
      getCourses: () => this.getCourses(),
      getCourseContents: (courseId) => this.getCourseContents(courseId),
    });
  }

  async getSiteInfo(): Promise<UserInfo> {
    await this.ensureSession();
    try {
      const data = await this.call(FUNC_GET_SITE_INFO);
      if (isRecord(data) && "userid" in data) {
        const info = parseUserInfo(data);
        this.sesskey = typeof data.sesskey === "string" ? data.sesskey : this.sesskey;
        this.userid = info.userid;
        this.userInfo = info;
        await this.writeCache();
        return info;
      }
    } catch (error) {
      if (!this.errors.isApi(error) || error.moodleErrorCode !== "servicenotavailable") {
        throw error;
      }
    }
    // Sites like Monash disable core_webservice_get_site_info; scrape the dashboard instead.
    if (this.userInfo?.fullname) {
      return this.userInfo;
    }
    const html = await this.get(DASHBOARD_PATH);
    const context = parsePageContext(html, this.baseUrl);
    if (!context.user_info.fullname && this.userInfo) {
      return this.userInfo;
    }
    this.applyContext(context);
    await this.writeCache();
    return context.user_info;
  }

  async getCourses(): Promise<Course[]> {
    await this.ensureSession();
    try {
      const data = await this.call(FUNC_GET_COURSES, { userid: this.userid });
      return parseCourses(data);
    } catch (error) {
      if (!this.errors.isApi(error) || error.moodleErrorCode !== "servicenotavailable") {
        throw error;
      }
      return this.getCoursesTimeline();
    }
  }

  async resolveCourseReference(value: string): Promise<number> {
    const raw = value.trim();
    if (/^\d+$/.test(raw)) {
      return Number(raw);
    }
    const courses = await this.getCourses();
    const matches = courses.filter((course) => queryMatches(course.fullname, raw) || queryMatches(course.shortname, raw));
    if (matches.length === 1) {
      return matches[0].id;
    }
    if (!matches.length) {
      throw this.errors.notFound(`Could not find a course matching '${raw}'. Run 'moodle courses' to inspect course IDs.`);
    }
    throw this.errors.notFound(`Course '${raw}' is ambiguous. Matches: ${matches.slice(0, 5).map((course) => `${course.id}:${course.fullname || course.shortname}`).join(", ")}`);
  }

  async getCourseContents(courseId: number): Promise<Section[]> {
    await this.ensureSession();
    try {
      return parseCourseContents(await this.call(FUNC_GET_COURSE_CONTENTS, { courseid: courseId }));
    } catch (error) {
      if (!this.errors.isApi(error) || error.moodleErrorCode !== "servicenotavailable") {
        throw error;
      }
    }
    const response = await this.get(COURSE_PATH, { id: courseId });
    return this.scrapeCourseContents(courseId, response);
  }

  async getActivities(courseId: number): Promise<Section["activities"]> {
    return (await this.getCourseContents(courseId)).flatMap((section) => section.activities);
  }

  async getActivity(id: number): Promise<ActivityDetail & { type: string }> {
    await this.ensureSession();
    const data = await this.call(FUNC_GET_COURSE_MODULE, { cmid: id });
    const module = isRecord(data) && isRecord(data.cm) ? data.cm : data;
    const type = isRecord(module) && typeof module.modname === "string" ? module.modname : "";
    const loaders: Record<string, () => Promise<ActivityDetail>> = {
      assign: () => this.getAssignment(id),
      quiz: () => this.getQuiz(id),
      resource: () => this.getResource(id),
      url: () => this.getLink(id),
      page: () => this.getPage(id),
      folder: () => this.getFolder(id),
    };
    const load = loaders[type];
    if (!load) {
      throw this.errors.notFound(`Activity ${id} is not a supported assignment, quiz, resource, link, page, or folder.`);
    }
    return { ...(await load()), type: type === "url" ? "link" : type };
  }

  async getTodo(limit = 20, days?: number): Promise<TodoItem[]> {
    await this.ensureSession();
    const now = Math.floor(Date.now() / 1000);
    const data = await this.call(FUNC_GET_ACTION_EVENTS, {
      limitnum: limit,
      timesortfrom: now,
      timesortto: days ? now + days * 24 * 60 * 60 : 0,
      aftereventid: 0,
      limittononsuspendedevents: true,
    });
    const events = isRecord(data) && Array.isArray(data.events) ? data.events : [];
    return parseTodoItems(events);
  }

  async getAlerts(limit = 20): Promise<AlertSummary> {
    await this.ensureSession();
    const [notifications, counts, unread] = await this.callBatchValues([
      { methodname: FUNC_GET_POPUP_NOTIFICATIONS, args: { useridto: this.userid, limit, offset: 0 } },
      { methodname: FUNC_GET_CONVERSATION_COUNTS, args: { userid: this.userid } },
      { methodname: FUNC_GET_UNREAD_CONVERSATION_COUNTS, args: { userid: this.userid } },
    ]);
    return parseAlertSummary(notifications, counts, unread);
  }

  async getOverview(todoLimit = 5, todoDays?: number, alertsLimit = 5): Promise<Overview> {
    await this.ensureSession();
    const now = Math.floor(Date.now() / 1000);
    const results = await this.callBatch([
      { methodname: FUNC_GET_COURSES, args: { userid: this.userid } },
      {
        methodname: FUNC_GET_ACTION_EVENTS,
        args: {
          limitnum: todoLimit,
          timesortfrom: now,
          timesortto: todoDays ? now + todoDays * 24 * 60 * 60 : 0,
          aftereventid: 0,
          limittononsuspendedevents: true,
        },
      },
      { methodname: FUNC_GET_POPUP_NOTIFICATIONS, args: { useridto: this.userid, limit: alertsLimit, offset: 0 } },
      { methodname: FUNC_GET_CONVERSATION_COUNTS, args: { userid: this.userid } },
      { methodname: FUNC_GET_UNREAD_CONVERSATION_COUNTS, args: { userid: this.userid } },
    ]);
    const [coursesData, todoData, notifications, counts, unread] = results;
    const errors = results.flatMap((result, index) => {
      if (result.ok) {
        return [];
      }
      const labels = ["courses", "todo", "notifications", "conversation counts", "unread conversation counts"];
      return [`${labels[index]}: ${result.error.message}`];
    });
    const todoPayload = todoData?.ok ? todoData.data : {};
    return {
      user: this.userInfo!,
      courses: coursesData?.ok ? parseCourses(coursesData.data) : [],
      todo: parseTodoItems(isRecord(todoPayload) && Array.isArray(todoPayload.events) ? todoPayload.events : []),
      alerts:
        notifications?.ok && counts?.ok && unread?.ok
          ? parseAlertSummary(notifications.data, counts.data, unread.data)
          : undefined,
      errors,
    };
  }

  async getCourseGrades(courseId: number): Promise<CourseGrades> {
    await this.ensureSession();
    const courseHtml = await this.get(COURSE_PATH, { id: courseId });
    const candidates = [
      parseCourseGradesUrl(courseHtml, this.baseUrl),
      `${this.baseUrl}/course/user.php?mode=grade&id=${courseId}&user=${this.userid}`,
      `${this.baseUrl}${GRADE_REPORT_OVERVIEW_PATH}`,
      `${this.baseUrl}${GRADE_REPORT_INDEX_PATH}?id=${courseId}`,
      `${this.baseUrl}${GRADE_REPORT_PATH}?id=${courseId}`,
    ].filter(Boolean);
    const seen = new Set<string>();
    let overviewRows: Record<number, { course_name: string; grade: string; url: string }> = {};
    for (let index = 0; index < candidates.length; index += 1) {
      const url = candidates[index];
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      let html = "";
      try {
        html = await this.getAbsolute(url);
      } catch (error) {
        if (this.errors.isApi(error) && error.message.startsWith("HTTP 404")) {
          continue;
        }
        throw error;
      }
      if (hasCourseGradesHtml(html)) {
        return parseCourseGradesHtml(html, courseId, this.baseUrl);
      }
      overviewRows = parseGradeOverviewRows(html, this.baseUrl);
      const row = overviewRows[courseId];
      if (row) {
        if (row.url && !seen.has(row.url)) {
          candidates.push(row.url);
          continue;
        }
        return {
          course_id: courseId,
          course_name: row.course_name,
          learner_name: "",
          total_grade: row.grade,
          total_range: "",
          total_percentage: "",
          items: [],
        };
      }
    }
    return {
      course_id: courseId,
      course_name: "",
      learner_name: "",
      total_grade: "",
      total_range: "",
      total_percentage: "",
      items: [],
    };
  }

  async getAssignment(id: number): Promise<Assignment> {
    return parseAssignmentHtml(await this.get(ASSIGN_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getQuiz(id: number): Promise<Quiz> {
    return parseQuizHtml(await this.get(QUIZ_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getResource(id: number): Promise<Resource> {
    return parseResourceHtml(await this.get(RESOURCE_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getLink(id: number): Promise<Link> {
    return parseLinkHtml(await this.get(URL_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getPage(id: number): Promise<Page> {
    return parsePageHtml(await this.get(PAGE_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getFolder(id: number): Promise<Folder> {
    return parseFolderHtml(await this.get(FOLDER_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getForumDiscussion(discussionId: number): Promise<ForumDiscussion> {
    return this.forum.getForumDiscussion(discussionId);
  }

  async getForumViewCmid(discussionId: number): Promise<number | null> {
    return this.forum.getForumViewCmid(discussionId);
  }

  async resolveCourseIdForUrl(url: string): Promise<number | null> {
    return parseCourseIdFromPageHtml(await this.getAbsolute(url));
  }

  async getForumDiscussionRefs(forumCmid: number): Promise<ForumDiscussionRef[]> {
    return this.forum.getForumDiscussionRefs(forumCmid);
  }

  async getForums(courseId?: number): Promise<ForumActivityRef[]> {
    return this.forum.getForums(courseId);
  }

  async searchForumContent(options: {
    query: string;
    limit?: number;
    courseId?: number;
    forumCmid?: number;
    includePostText?: boolean;
    unreadOnly?: boolean;
    sortBy?: "relevance" | "recent";
    maxForums?: number;
    maxDiscussionsPerForum?: number;
  }): Promise<ForumSearchHit[]> {
    const { query, ...searchOptions } = options;
    return searchForumModule(this.forum, query, { ...searchOptions, baseUrl: this.baseUrl });
  }

  async callBatch(requests: AjaxCall[]): Promise<AjaxBatchResult[]> {
    await this.ensureSession();
    return this.callBatchInternal(requests, true);
  }

  private async call(functionName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const [result] = await this.callBatchValues([{ methodname: functionName, args }]);
    return result;
  }

  private async callBatchValues(requests: AjaxCall[]): Promise<unknown[]> {
    const results = await this.callBatchInternal(requests, true);
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) {
      throw failed.error;
    }
    return results.map((result) => (result.ok ? result.data : undefined));
  }

  private async callBatchInternal(requests: AjaxCall[], allowRetry: boolean): Promise<AjaxBatchResult[]> {
    const payload = requests.map((request, index) => ({ index, methodname: request.methodname, args: request.args ?? {} }));
    const response = await this.fetchImpl(`${this.baseUrl}${AJAX_SERVICE_PATH}?sesskey=${encodeURIComponent(this.sesskey ?? "")}&info=${requests.map((request) => request.methodname).join(",")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${this.cookie.name}=${this.cookie.value}`,
      },
      body: JSON.stringify(payload),
    });
    if (response.url.includes("/login/") && this.onLoginRequired && allowRetry && !this.retryingLogin) {
      await this.reauthenticate();
      return this.callBatchInternal(requests, false);
    }
    const body = await response.json();
    const envelope = AjaxEnvelopeSchema.parse(body);
    const results: AjaxBatchResult[] = envelope.map((item) => {
      if (item.error) {
        return {
          ok: false,
          error: this.errors.api(item.exception?.message ?? "Unknown API error", item.exception?.errorcode),
        };
      }
      return { ok: true, data: item.data ?? item };
    });
    if (
      allowRetry &&
      !this.retryingLogin &&
      this.onLoginRequired &&
      results.some((result) => !result.ok && this.errors.isLoginRequired(result.error))
    ) {
      await this.reauthenticate();
      return this.callBatchInternal(requests, false);
    }
    return results;
  }

  private async ensureSession(): Promise<void> {
    if (this.sesskey && this.userid) {
      return;
    }
    const html = await this.get(DASHBOARD_PATH);
    const context = parsePageContext(html, this.baseUrl);
    this.applyContext(context);
    await this.writeCache();
  }

  private async get(pathname: string, params: Record<string, string | number> = {}): Promise<string> {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
    return this.getAbsolute(`${this.baseUrl}${pathname}${query ? `?${query}` : ""}`);
  }

  private async getAbsolute(url: string): Promise<string> {
    const response = await this.fetchImpl(url, { headers: { cookie: `${this.cookie.name}=${this.cookie.value}` }, redirect: "follow" });
    if (response.url.includes("/login/") && this.onLoginRequired && !this.retryingLogin) {
      await this.reauthenticate();
      return this.getAbsolute(url);
    }
    if (!response.ok) {
      throw this.errors.api(`HTTP ${response.status} loading ${url}`);
    }
    return response.text();
  }

  private async getCoursesTimeline(): Promise<Course[]> {
    const courses: unknown[] = [];
    let offset = 0;
    while (true) {
      const data = await this.call(FUNC_GET_COURSES_BY_TIMELINE, { classification: "all", limit: 100, offset });
      if (!isRecord(data) || !Array.isArray(data.courses) || !data.courses.length) {
        break;
      }
      courses.push(...data.courses);
      const nextOffset = typeof data.nextoffset === "number" ? data.nextoffset : offset;
      if (nextOffset <= offset) {
        break;
      }
      offset = nextOffset;
    }
    return parseCourses(courses);
  }

  private async scrapeCourseContents(courseId: number, rootHtml: string): Promise<Section[]> {
    const pages = [rootHtml];
    for (const section of parseCourseSectionNumbers(rootHtml, courseId)) {
      if (section !== 0) {
        pages.push(await this.get(COURSE_PATH, { id: courseId, section }));
      }
    }
    const seen = new Set<number>();
    const sections: Section[] = [];
    for (const html of pages) {
      for (const section of parseCourseContentsHtml(html, this.baseUrl)) {
        const key = section.section || section.id;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        sections.push(section);
      }
    }
    return sections;
  }

  private async reauthenticate(): Promise<void> {
    if (!this.onLoginRequired) {
      throw this.errors.api("Session expired", "servicerequireslogin");
    }
    this.retryingLogin = true;
    await this.clearSessionCache?.();
    try {
      const auth = await this.onLoginRequired();
      this.cookie = auth.cookie;
      this.applyContext(auth.pageContext);
      await this.writeCache();
    } finally {
      this.retryingLogin = false;
    }
  }

  private applyContext(context: PageContext): void {
    this.sesskey = context.sesskey;
    this.userid = context.user_info.userid;
    this.userInfo = context.user_info;
  }

  private async writeCache(): Promise<void> {
    if (this.writeSessionCache && this.sesskey && this.userid) {
      try {
        await this.writeSessionCache({
          baseUrl: this.baseUrl,
          cookieName: this.cookie.name,
          cookieValue: this.cookie.value,
          sesskey: this.sesskey,
          userid: this.userid,
        });
      } catch {
        return;
      }
    }
  }
}

export function createMoodleClientCore(
  baseUrl: string,
  options: MoodleClientCoreOptions | string,
): MoodleClientCore {
  return new MoodleClientCore(baseUrl, options);
}

function placeholderUserInfo(baseUrl: string, userid: number): UserInfo {
  return {
    userid,
    username: "",
    fullname: "",
    sitename: "",
    siteurl: baseUrl,
    lang: "",
  };
}

function queryMatches(text: string, query: string): boolean {
  const haystack = text.toLowerCase().split(/\s+/).join(" ");
  const needle = query.toLowerCase().split(/\s+/).join(" ");
  return needle ? haystack.includes(needle) || needle.split(" ").every((token) => haystack.includes(token)) : true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLoginErrorCode(code: string | undefined): boolean {
  return ["servicerequireslogin", "sitepolicynotagreed"].includes(code ?? "");
}
