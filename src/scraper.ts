import { HTMLElement, parse } from "node-html-parser";
import type {
  Activity,
  Assignment,
  CourseGrades,
  FileEntry,
  Folder,
  ForumDiscussion,
  ForumDiscussionRef,
  ForumPost,
  GradeItem,
  Link,
  Page,
  PageContext,
  Quiz,
  Resource,
  Section,
} from "./models.js";
import { cleanText, htmlToStructuredContent, resolveUrl } from "./html-utils.js";

export interface MoodlePageError {
  message: string;
  code?: string;
}

export function parseMoodleErrorHtml(html: string): MoodlePageError | null {
  const root = parse(html);
  const messageNode = first(root, [
    ".errormessage",
    ".alert-danger .alert-message",
    "[data-region='error-message']",
    ".alert-danger[role='alert']",
    ".alert-danger",
  ]);
  if (!messageNode) {
    return null;
  }

  const messageRoot = parse(messageNode.toString());
  for (const unwanted of messageRoot.querySelectorAll(
    "button, .close, .errorcode, .stacktrace, .debuginfo, .backtrace, a.alert-link, a[href*='/error/']",
  )) {
    unwanted.remove();
  }
  const message = cleanText(messageRoot.textContent);
  if (!message) {
    return null;
  }

  const errorCodeText = cleanNodeText(root.querySelector(".errorcode"));
  const errorCode = errorCodeText.match(/^error\s+code\s*:\s*([a-z][a-z0-9_]*)\s*$/iu)?.[1]
    ?? moodleDocsErrorCode(root);
  return { message, ...(errorCode ? { code: errorCode } : {}) };
}

export function parsePageContext(html: string, baseUrl: string): PageContext {
  const root = parse(html);
  const config = parseMoodleConfig(html);
  const sesskey = stringValue(config.sesskey).trim();
  const userid = numberValue(config.userId) || numberValue(root.querySelector("[data-user-id]")?.getAttribute("data-user-id"));
  if (!sesskey || !userid) {
    throw new Error("Session appears invalid: could not load authenticated Moodle context");
  }
  return {
    sesskey,
    user_info: {
      userid,
      username: "",
      fullname: cleanNodeText(root.querySelector(".userfullname")),
      sitename: extractSitename(root),
      siteurl: baseUrl,
      lang: stringValue(config.language) || root.querySelector("html")?.getAttribute("lang") || "",
    },
  };
}

export function parseCourseContentsHtml(html: string, baseUrl: string): Section[] {
  const root = parse(html);
  const sections: Section[] = [];
  for (const sectionElement of root.querySelectorAll('li[data-for="section"]')) {
    const sectionId = safeInt(sectionElement.getAttribute("data-id"));
    const sectionNumber = safeInt(sectionElement.getAttribute("data-number") ?? sectionElement.getAttribute("data-sectionnum"));
    const positionName = cleanNodeText(sectionElement.querySelector(".course-section-position-name"));
    const mainName = cleanNodeText(
      firstDefined([
        first(sectionElement, ["h1.sectionname", "h2.sectionname", "h3.sectionname"]),
        sectionElement.querySelector('[data-for="section_title"] a'),
        sectionElement.querySelector('[data-for="section_title"]'),
      ]),
    );
    const name =
      positionName && mainName && positionName !== mainName
        ? `${positionName} - ${mainName}`
        : mainName || positionName || `Section ${sectionNumber}`;
    const visible = !(sectionElement.getAttribute("class") ?? "").split(/\s+/).includes("hidden");
    const activities: Activity[] = [];
    const seenActivities = new Set<number>();
    for (const activityElement of sectionElement.querySelectorAll('li[data-for="cmitem"]')) {
      const id = safeInt(activityElement.getAttribute("data-id"));
      if (id && seenActivities.has(id)) {
        continue;
      }
      if (id) {
        seenActivities.add(id);
      }
      const classes = (activityElement.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
      const modname = classes.find((item) => item.startsWith("modtype_"))?.slice("modtype_".length) ?? "";
      const name = cleanNodeText(
        firstDefined([
          activityElement.querySelector(".activityname .instancename"),
          activityElement.querySelector(".activityname"),
          activityElement.querySelector("a.aalink"),
        ]),
      );
      if (!name) {
        continue;
      }
      const href = activityElement.querySelector(".activityname a, a.aalink, a[href]")?.getAttribute("href") ?? "";
      activities.push({
        id,
        name,
        modname,
        url: href ? resolveUrl(baseUrl, href) : "",
        visible: !classes.some((item) => ["hidden", "stealth", "dimmed"].includes(item)),
        description: cleanNodeText(first(activityElement, ["[data-region='activity-description']", ".contentafterlink", ".description"])),
      });
    }
    sections.push({
      id: sectionId,
      name,
      section: sectionNumber,
      visible,
      summary: cleanNodeText(first(sectionElement, [".summarytext", "[data-for='sectioninfo']"])),
      activities,
    });
  }
  return sections;
}

export function parseCourseSectionNumbers(html: string, courseId: number): number[] {
  const sections: number[] = [];
  const root = parse(html.replace(/&section=/gu, "&amp;section="));
  const hrefs = root.querySelectorAll('a[href*="/course/view.php"]')
    .map((link) => link.getAttribute("href") ?? "");
  for (const href of hrefs) {
    const url = parseMaybeUrl(href.replace(/&amp;/gu, "&"), "https://moodle.invalid");
    const id = url?.searchParams.get("id");
    const sectionValue = url?.searchParams.get("section");
    if (id === String(courseId) && sectionValue && /^\d+$/.test(sectionValue)) {
      const section = Number(sectionValue);
      if (!sections.includes(section)) {
        sections.push(section);
      }
    }
  }
  return sections;
}

export function parseCourseGradesUrl(html: string, baseUrl: string): string {
  const root = parse(html);
  const link =
    root.querySelector('li[data-key="grades"] a[href]') ??
    root.querySelector('.secondary-navigation a[href*="mode=grade"]') ??
    root.querySelector('.secondary-navigation a[href*="/grade/report/"]') ??
    root.querySelector('a[href*="mode=grade"], a[href*="/grade/report/"]');
  const href = link?.getAttribute("href") ?? "";
  return href ? resolveUrl(baseUrl, href) : "";
}

export function parseCourseIdFromPageHtml(html: string): number | null {
  const root = parse(html);
  for (const link of root.querySelectorAll('a[href*="/course/view.php?id="]')) {
    const courseId = numberQueryValue(link.getAttribute("href") ?? "", "id");
    if (courseId !== null) {
      return courseId;
    }
  }
  return null;
}

export function hasCourseGradesHtml(html: string): boolean {
  return parse(html).querySelector("table.user-grade") !== null;
}

export function parseCourseGradesHtml(html: string, courseId: number, baseUrl: string): CourseGrades {
  const root = parse(html);
  const report: CourseGrades = {
    course_id: courseId,
    course_name: cleanNodeText(root.querySelector("h1")),
    learner_name: cleanNodeText(
      firstDefined([
        root.querySelector(".grade-report-user .page-header-headings h2"),
        root.querySelector(".page-header-headings h2"),
        root.querySelector(".grade-report-user h2 a"),
        root.querySelector("h2 a"),
        root.querySelector("h2"),
      ]),
    ),
    total_grade: "",
    total_range: "",
    total_percentage: "",
    items: [],
  };
  const table = root.querySelector("table.user-grade");
  if (!table) {
    return report;
  }
  for (const row of table.querySelectorAll("tr")) {
    const title = cleanNodeText(row.querySelector(".rowtitle"));
    if (!title || row.querySelector(".toggle-category")) {
      continue;
    }
    if (title === "Course total") {
      report.total_grade = cleanTableCell(row.querySelector("td.column-grade"));
      report.total_range = cleanTableCell(row.querySelector("td.column-range"));
      report.total_percentage = cleanTableCell(row.querySelector("td.column-percentage"));
      continue;
    }
    const link = row.querySelector(".rowtitle a.gradeitemheader, .rowtitle a");
    if (!link) {
      continue;
    }
    const statusIcon = row.querySelector("td.column-grade i[aria-label], td.column-grade i[title]");
    const item: GradeItem = {
      name: title,
      item_type: cleanText(row.querySelector(".item img.itemicon, .courseitem img.itemicon, img.itemicon")?.getAttribute("alt") ?? ""),
      grade: cleanTableCell(row.querySelector("td.column-grade")),
      range: cleanTableCell(row.querySelector("td.column-range")),
      percentage: cleanTableCell(row.querySelector("td.column-percentage")),
      weight: cleanTableCell(row.querySelector("td.column-weight")),
      contribution: cleanTableCell(row.querySelector("td.column-contributiontocoursetotal")),
      feedback: cleanTableCell(row.querySelector("td.column-feedback")),
      url: resolveUrl(baseUrl, link.getAttribute("href") ?? ""),
      status: statusIcon?.getAttribute("aria-label") ?? statusIcon?.getAttribute("title") ?? "",
    };
    report.items.push(item);
  }
  return report;
}

export function parseGradeOverviewRows(html: string, baseUrl: string): Record<number, { course_name: string; grade: string; url: string }> {
  const rows: Record<number, { course_name: string; grade: string; url: string }> = {};
  const table = parse(html).querySelector("table#overview-grade");
  if (!table) {
    return rows;
  }
  for (const row of table.querySelectorAll("tbody tr, tr")) {
    const link = row.querySelector("td a[href]");
    if (!link) {
      continue;
    }
    const href = resolveUrl(baseUrl, link.getAttribute("href") ?? "");
    const courseId = numberQueryValue(href, "id");
    if (courseId === null) {
      continue;
    }
    const cells = row.querySelectorAll("td");
    rows[courseId] = {
      course_name: cleanNodeText(link),
      grade: cleanNodeText(cells[1]),
      url: href,
    };
  }
  return rows;
}

export function parseAssignmentHtml(html: string, assignmentId: number, baseUrl: string): Assignment {
  return {
    id: assignmentId,
    name: pageTitle(html),
    ...activityContext(html),
    due_pretty: extractLabeledText(html, "Due:"),
    submission_status: findTableValue(html, "Submission status"),
    grading_status: findTableValue(html, "Grading status"),
    time_remaining: findTableValue(html, "Time remaining"),
    grade: findTableValue(html, "Grade"),
    url: `${baseUrl.replace(/\/$/, "")}/mod/assign/view.php?id=${assignmentId}`,
  };
}

export function parseQuizHtml(html: string, quizId: number, baseUrl: string): Quiz {
  const root = parse(html);
  return {
    id: quizId,
    name: pageTitle(html),
    ...activityContext(html),
    opens_pretty: extractLabeledText(html, "Opens:"),
    closes_pretty: extractLabeledText(html, "Closes:"),
    attempts_allowed: cleanText(root.textContent.match(/Attempts allowed:\s*([^\n]+)/i)?.[1] ?? ""),
    availability: cleanText(root.textContent.match(/This quiz is currently[^\n]+/i)?.[0] ?? ""),
    grade: findTableValue(html, "Grade"),
    url: `${baseUrl.replace(/\/$/, "")}/mod/quiz/view.php?id=${quizId}`,
  };
}

export function parseResourceHtml(html: string, resourceId: number, baseUrl: string): Resource {
  const root = parse(html);
  const link = root.querySelector(".resourceworkaround a[href], .resourcecontent a[href], a.resourceworkaround[href]");
  const targetName = cleanNodeText(link);
  const targetUrl = link ? resolveUrl(baseUrl, link.getAttribute("href") ?? "") : "";
  return {
    id: resourceId,
    name: pageTitle(html),
    ...activityContext(html),
    target_name: targetName,
    target_url: targetUrl,
    file_entries: targetName && targetUrl ? [fileEntry(targetName, targetUrl, baseUrl)] : [],
    url: `${baseUrl.replace(/\/$/, "")}/mod/resource/view.php?id=${resourceId}`,
  };
}

export function parseLinkHtml(html: string, linkId: number, baseUrl: string): Link {
  const root = parse(html);
  const link = root.querySelector(".urlworkaround a[href], .mod_url-content a[href], .externalurl a[href]");
  return {
    id: linkId,
    name: pageTitle(html),
    ...activityContext(html),
    target_url: link?.getAttribute("href") ?? "",
    url: `${baseUrl.replace(/\/$/, "")}/mod/url/view.php?id=${linkId}`,
  };
}

export function parsePageHtml(html: string, pageId: number, baseUrl: string): Page {
  const root = parse(html);
  const content = first(root, [".box.generalbox", ".activity-description", "[data-region='page-content']", "main"]);
  return {
    id: pageId,
    name: pageTitle(html),
    ...activityContext(html),
    content_text: content ? htmlToStructuredContent(content.innerHTML, baseUrl).text : "",
    url: `${baseUrl.replace(/\/$/, "")}/mod/page/view.php?id=${pageId}`,
  };
}

export function parseFolderHtml(html: string, folderId: number, baseUrl: string): Folder {
  const root = parse(html);
  const fileEntries = root.querySelectorAll(".foldertree a[href], .fp-filename-icon a[href]")
    .map((link) => {
      const name = cleanNodeText(link);
      const url = resolveUrl(baseUrl, link.getAttribute("href") ?? "");
      return name && url ? fileEntry(name, url, baseUrl) : null;
    })
    .filter((entry): entry is FileEntry => entry !== null)
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.url === entry.url) === index);
  return {
    id: folderId,
    name: pageTitle(html),
    ...activityContext(html),
    files: unique(fileEntries.map((entry) => entry.name)),
    file_entries: fileEntries,
    url: `${baseUrl.replace(/\/$/, "")}/mod/folder/view.php?id=${folderId}`,
  };
}

export function parseForumDiscussionHtml(html: string, baseUrl: string, discussionId: number): ForumDiscussion {
  const root = parse(html);
  let postElements = root.querySelectorAll("div.forumpost[data-post-id]");
  if (!postElements.length) {
    postElements = root.querySelectorAll("article[data-post-id]");
  }

  const [groupId, groupName] = parseForumDiscussionGroupHtml(html);
  const posts: ForumPost[] = [];

  for (const element of postElements) {
    const postId = safeInt(element.getAttribute("data-post-id"));
    if (!postId) {
      continue;
    }

    const header = first(element, ["header", ".header"]);
    const subject = cleanNodeText(
      firstDefined([
        header ? first(header, ["h3"]) : null,
        first(element, ["h3", "[data-region='post-title']"]),
      ]),
    );
    const authorLink =
      firstDefined([
        header ? first(header, ['a[href*="/user/"]']) : null,
        first(element, ['a[href*="/user/"]', 'a[href*="/user/profile.php"]']),
      ]) ?? null;
    const messageElement = first(element, [
      ".post-content-container",
      ".content",
      "[data-region='post-content']",
      "[data-region-content='forum-post-core']",
    ]);
    const messageHtml = messageElement?.innerHTML ?? "";
    const structured = htmlToStructuredContent(messageHtml, baseUrl);

    posts.push({
      id: postId,
      discussion_id: discussionId,
      subject,
      message_html: messageHtml,
      message_text: structured.text,
      image_urls: structured.image_urls,
      links: structured.links,
      tables: structured.tables,
      author: {
        id: 0,
        fullname: cleanNodeText(authorLink),
        profile_url: authorLink ? resolveUrl(baseUrl, authorLink.getAttribute("href") ?? "") : "",
        profile_image_url: "",
      },
      parent_id: 0,
      time_created: 0,
      time_modified: 0,
      created_pretty: cleanNodeText(header ? first(header, [".date", "time"]) : null),
      unread: false,
      is_deleted: false,
      is_private_reply: false,
      url: `${baseUrl.replace(/\/$/, "")}/mod/forum/discuss.php?d=${discussionId}#p${postId}`,
      reply_url: `${baseUrl.replace(/\/$/, "")}/mod/forum/post.php?reply=${postId}#mformforum`,
    });
  }

  return {
    id: discussionId,
    subject: posts[0]?.subject ?? "",
    course_id: 0,
    forum_id: 0,
    group_id: groupId,
    group_name: groupName,
    url: `${baseUrl.replace(/\/$/, "")}/mod/forum/discuss.php?d=${discussionId}`,
    posts,
  };
}

export function parseForumViewCmidFromDiscussionHtml(html: string): number | null {
  const root = parse(html);
  const link = first(root, ['a[href*="/mod/forum/view.php?id="]', 'a[href*="mod/forum/view.php?id="]']);
  const href = link?.getAttribute("href") ?? "";
  if (!href) {
    return null;
  }
  const url = parseMaybeUrl(href, "https://moodle.invalid");
  if (!url || !url.pathname.endsWith("/mod/forum/view.php")) {
    return null;
  }
  return numericQueryValue(url, "id");
}

export function parseForumDiscussionRefsHtml(html: string, baseUrl: string): ForumDiscussionRef[] {
  const root = parse(html);
  const refs: ForumDiscussionRef[] = [];
  const seen = new Set<number>();
  const links = [
    ...root.querySelectorAll('a[href*="/mod/forum/discuss.php?d="]'),
    ...root.querySelectorAll('a[href*="mod/forum/discuss.php?d="]'),
    ...root.querySelectorAll('a[href*="discuss.php?d="]'),
  ];

  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    const url = parseMaybeUrl(href, baseUrl);
    if (!url || !url.pathname.endsWith("/mod/forum/discuss.php")) {
      continue;
    }
    const discussionId = numericQueryValue(url, "d");
    if (!discussionId || seen.has(discussionId)) {
      continue;
    }
    const subject = cleanNodeText(link);
    if (!subject || ["permalink", "discuss"].includes(subject.toLowerCase())) {
      continue;
    }
    seen.add(discussionId);
    refs.push({
      id: discussionId,
      subject,
      group_id: 0,
      group_name: "",
      url: resolveUrl(baseUrl, href),
    });
  }

  return refs;
}

export function parseForumGroupsHtml(html: string): Array<[number, string]> {
  const root = parse(html);
  const select = first(root, ["form#selectgroup select[name='group']", "select[name='group']"]);
  if (!select) {
    return [];
  }

  const groups: Array<[number, string]> = [];
  const seen = new Set<string>();
  for (const option of select.querySelectorAll("option")) {
    const groupId = safeInt(option.getAttribute("value"));
    if (!groupId) {
      continue;
    }
    const groupName = cleanNodeText(option);
    const key = `${groupId}:${groupName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    groups.push([groupId, groupName]);
  }
  return groups;
}

export function parseForumGroupIdsHtml(html: string): number[] {
  return parseForumGroupsHtml(html).map(([groupId]) => groupId);
}

export function parseForumDiscussionGroupHtml(html: string): [number, string] {
  const root = parse(html);
  const groupId = safeInt(root.querySelector("form#mformforum input[name='groupid']")?.getAttribute("value"));
  return [groupId, selectedGroupName(root, groupId)];
}

function selectedGroupName(root: HTMLElement, groupId: number): string {
  if (groupId <= 0) {
    return "";
  }
  for (const selector of ["select[name='groupinfo']", "select[name='group']"]) {
    const option = root.querySelector(selector)?.querySelector(`option[value='${groupId}']`) ?? null;
    if (option) {
      return cleanNodeText(option);
    }
  }
  return "";
}

function moodleDocsErrorCode(root: HTMLElement): string | undefined {
  for (const link of root.querySelectorAll("a[href*='/error/']")) {
    const href = link.getAttribute("href") ?? "";
    const code = href.match(/\/error\/[^/]+\/([a-z][a-z0-9_]*)/iu)?.[1];
    if (code) {
      return code;
    }
  }
  return undefined;
}

function cleanNodeText(node: HTMLElement | null | undefined): string {
  return cleanText(node?.textContent ?? "");
}

function first(root: HTMLElement, selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const match = root.querySelector(selector);
    if (match) {
      return match;
    }
  }
  return null;
}

function firstDefined<T>(items: Array<T | null | undefined>): T | null {
  return items.find((item): item is T => item !== null && item !== undefined) ?? null;
}

function safeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return 0;
}

function parseMaybeUrl(href: string, baseUrl: string): URL | null {
  try {
    return new URL(href, baseUrl);
  } catch {
    return null;
  }
}

function numericQueryValue(url: URL, key: string): number | null {
  const value = url.searchParams.get(key);
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

function parseMoodleConfig(html: string): Record<string, unknown> {
  const match = html.match(/M\.cfg\s*=\s*({[\s\S]*?});/);
  if (!match) {
    return {};
  }
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractSitename(root: HTMLElement): string {
  const title = cleanNodeText(root.querySelector("title"));
  return title.includes("|") ? title.split("|").at(-1)?.trim() ?? title : title;
}

function pageTitle(html: string): string {
  return cleanNodeText(parse(html).querySelector("h1"));
}

function activityContext(html: string): { course_id: number; course_name: string; section_name: string } {
  const root = parse(html);
  const context = { course_id: parseCourseIdFromPageHtml(html) ?? 0, course_name: "", section_name: "" };
  const breadcrumbs = root.querySelectorAll('nav[aria-label="Breadcrumb"] a[href], #page-navbar .breadcrumb a[href]');
  const links = breadcrumbs.length ? breadcrumbs : root.querySelectorAll('a[href*="/course/view.php?id="]');
  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    const courseId = numberQueryValue(href, "id");
    if (courseId !== null) {
      context.course_id = courseId;
    }
    if (numberQueryValue(href, "section") === null) {
      context.course_name ||= cleanNodeText(link);
    } else {
      context.section_name = cleanNodeText(link);
    }
  }
  return context;
}

function extractLabeledText(html: string, label: string): string {
  const root = parse(html);
  for (const node of root.querySelectorAll("strong, b")) {
    if (cleanNodeText(node) !== label) {
      continue;
    }
    const parent = node.parentNode as HTMLElement | null;
    return cleanText(parent?.textContent.replace(label, "") ?? "");
  }
  return "";
}

function findTableValue(html: string, label: string): string {
  const root = parse(html);
  for (const row of root.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("th, td");
    if (cleanNodeText(cells[0]) === label) {
      return cleanTableCell(cells[1]);
    }
  }
  return "";
}

function cleanTableCell(node: HTMLElement | null | undefined): string {
  if (!node) {
    return "";
  }
  const clone = parse(node.toString());
  for (const unwanted of clone.querySelectorAll(".action-menu, .dropdown, script, style")) {
    unwanted.remove();
  }
  return cleanText(clone.textContent.replace("( Empty )", "(Empty)"));
}

function numberQueryValue(href: string, key: string): number | null {
  try {
    return numericQueryValue(new URL(href, "https://moodle.invalid"), key);
  } catch {
    return null;
  }
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function fileEntry(name: string, url: string, baseUrl: string): FileEntry {
  return {
    name,
    url,
    requires_authentication: new URL(url).origin === new URL(baseUrl).origin,
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
