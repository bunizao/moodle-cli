import type {
  Activity,
  ActivityDetail,
  AlertSummary,
  Course,
  CourseGrades,
  ForumActivityRef,
  ForumCheckResult,
  ForumDiscussion,
  ForumDiscussionRef,
  ForumSearchHit,
  Section,
  TodoItem,
  UserInfo,
} from "./models.js";
import type { DownloadReceipt } from "./download.js";
import type { AuthStatus, KeepaliveRunResult } from "./keepalive.js";
import { renderKeyValueTable, renderTerminalTable, sanitizeTerminalText } from "./terminal-table.js";

export function formatUser(user: UserInfo): string {
  return renderKeyValueTable([
    ["User", user.fullname],
    ["Username", user.username],
    ["User ID", String(user.userid)],
    ["Site", user.sitename],
    ["URL", user.siteurl],
    ["Language", user.lang ?? ""],
  ], { title: "User" });
}

export function formatCourses(courses: Course[]): string {
  return renderTerminalTable(
    [
      { label: "ID" },
      { label: "Short Name" },
      { label: "Full Name" },
    ],
    courses.map((course) => [String(course.id), course.shortname, course.fullname]),
    { title: "Enrolled Units" },
  );
}

export function formatCourseSections(sections: Section[]): string {
  const lines = ["Course"];
  for (const [sectionIndex, section] of sections.entries()) {
    const sectionLast = sectionIndex === sections.length - 1;
    lines.push(`${sectionLast ? "└──" : "├──"} ${section.name || `Section ${section.section}`}${section.visible ? "" : " (hidden)"}`);
    if (!section.activities.length) {
      lines.push(`${sectionLast ? "    " : "│   "}└── No activities`);
      continue;
    }
    for (const [activityIndex, activity] of section.activities.entries()) {
      const activityPrefix = activityIndex === section.activities.length - 1 ? "└──" : "├──";
      lines.push(`${sectionLast ? "    " : "│   "}${activityPrefix} ${activity.name}${activity.visible ? "" : " (hidden)"} (${activity.modname})`);
    }
  }
  return sanitizeTerminalText(lines.join("\n"));
}

export function formatActivityList(value: Section[] | Activity[]): string {
  const activities = Array.isArray(value) && value[0] && "activities" in value[0]
    ? (value as Section[]).flatMap((section) => section.activities)
    : (value as Activity[]);
  return renderTerminalTable(
    [
      { label: "ID" },
      { label: "Type" },
      { label: "Name" },
    ],
    activities.map((activity) => [String(activity.id), activity.modname, activity.name]),
    { title: "Activities" },
  );
}

export function formatTodo(items: TodoItem[]): string {
  const columns = [
    { label: "Due" },
    { label: "Unit" },
    { label: "Activity" },
    { label: "Type" },
    { label: "Action" },
  ] as const;
  const rows = items.length ? items.map((item) => [
    `${item.overdue ? "Overdue · " : ""}${formatTimestamp(item.due_at)}`,
    `${item.course_name}${item.course_progress === undefined ? "" : ` (${item.course_progress}%)`}`,
    item.activity_name || item.name,
    item.modname || item.event_type,
    item.actionable ? item.action_name : "",
  ]) : [["No upcoming items", "", "", "", ""]];
  return renderTerminalTable(columns, rows, { title: "Todo" });
}

export function formatAlerts(alerts: AlertSummary): string {
  const summary = renderKeyValueTable([
    ["Notifications", String(alerts.notification_count)],
    ["Unread notifications", String(alerts.unread_notification_count)],
    ["Direct messages", String(alerts.direct_message_count)],
    ["Unread direct messages", String(alerts.unread_direct_message_count)],
  ], { title: "Alerts" });
  if (!alerts.notifications.length) return summary;
  const notifications = renderTerminalTable(
    [
      { label: "When" },
      { label: "Subject" },
    ],
    alerts.notifications.map((notification) => [
      notification.created_pretty || formatTimestamp(notification.created_at),
      notification.short_subject || notification.subject,
    ]),
    { title: "Notifications" },
  );
  return `${summary}\n\n${notifications}`;
}

export function formatGrades(grades: CourseGrades): string {
  return renderTerminalTable(
    [
      { label: "Item" },
      { label: "Grade" },
      { label: "Range" },
      { label: "Percent" },
      { label: "Feedback" },
    ],
    grades.items.map((item) => [item.name, item.grade, item.range, item.percentage, item.feedback]),
    { title: grades.course_name ? `Grades · ${grades.course_name}` : "Grades" },
  );
}

export function formatActivityDetail(activity: ActivityDetail): string {
  const rows = Object.entries(activity)
    .filter(([, value]) => value !== "" && value !== undefined && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : String(value)] as [string, string]);
  return renderKeyValueTable(rows, { title: "Activity" });
}

export function formatDownloadReceipt(receipt: DownloadReceipt): string {
  return renderKeyValueTable([
    ["File", receipt.file_path],
    ["Filename", receipt.filename],
    ["Bytes", String(receipt.bytes_written)],
    ["Content type", receipt.content_type],
    ["Source", receipt.source_url],
    ["Final URL", receipt.final_url],
  ], { title: "Download" });
}

export function formatForumDiscussion(
  discussion: ForumDiscussion,
  options: { highlightPostId?: number | null; showBody?: boolean } = {},
): string {
  const lines = [`Discussion: ${discussion.id}`];
  if (discussion.subject) {
    lines.push(`Subject: ${discussion.subject}`);
  }
  if (discussion.url) {
    lines.push(`URL: ${discussion.url}`);
  }
  if (discussion.course_id) {
    lines.push(`Course ID: ${discussion.course_id}`);
  }
  if (discussion.forum_id) {
    lines.push(`Forum ID: ${discussion.forum_id}`);
  }

  if (!discussion.posts.length) {
    lines.push("", "No posts");
    return sanitizeTerminalText(lines.join("\n"));
  }

  for (const post of discussion.posts) {
    const marker = options.highlightPostId === post.id ? "*" : "-";
    lines.push("", `${marker} Post ${post.id}`);
    lines.push(`  Author: ${post.author.fullname || "-"}`);
    lines.push(`  When: ${post.created_pretty || formatTimestamp(post.time_created)}`);
    if (post.subject) {
      lines.push(`  Subject: ${post.subject}`);
    }
    if (post.url) {
      lines.push(`  URL: ${post.url}`);
    }
    if (options.showBody) {
      if (post.message_text) {
        lines.push("", post.message_text);
      }
      if (post.image_urls.length) {
        lines.push("", "Images:", ...post.image_urls.map((url) => `- ${url}`));
      }
    } else {
      lines.push(`  Preview: ${preview(post.message_text)}`);
      lines.push(`  Images: ${post.image_urls.length}`);
    }
  }

  return sanitizeTerminalText(lines.join("\n"));
}

export function formatForumDiscussionRefs(forumCmid: number, refs: ForumDiscussionRef[]): string {
  return renderTerminalTable(
    [
      { label: "ID" },
      { label: "Subject" },
      { label: "Group" },
      { label: "URL" },
    ],
    refs.length
      ? refs.map((ref) => [String(ref.id), ref.subject, ref.group_name, ref.url])
      : [["No discussions", "", "", ""]],
    { title: `Forum ${forumCmid} · Discussions` },
  );
}

export function formatForumActivities(forums: ForumActivityRef[]): string {
  return renderTerminalTable(
    [
      { label: "ID" },
      { label: "Forum" },
      { label: "Unit" },
      { label: "URL" },
    ],
    forums.length
      ? forums.map((forum) => [String(forum.id), forum.name, forum.course_name, forum.url])
      : [["No forums", "", "", ""]],
    { title: "Forums" },
  );
}

export function formatForumSearchHits(hits: ForumSearchHit[]): string {
  return renderTerminalTable(
    [
      { label: "Discussion" },
      { label: "Post" },
      { label: "Unit" },
      { label: "Forum" },
      { label: "Subject" },
      { label: "Author" },
      { label: "Match" },
      { label: "Snippet" },
      { label: "URL" },
    ],
    hits.length ? hits.map((hit) => [
      String(hit.discussion_id),
      String(hit.post_id),
      hit.course_name,
      hit.forum_name,
      hit.discussion_subject,
      hit.author_name,
      hit.matched_in,
      hit.snippet || hit.discussion_subject,
      hit.url,
    ]) : [["No matches", "", "", "", "", "", "", "", ""]],
    { title: "Forum Search" },
  );
}

export function formatForumCheckResults(forumCmid: number, rows: ForumCheckResult[]): string {
  return renderTerminalTable(
    [
      { label: "Discussion" },
      { label: "OK" },
      { label: "Posts" },
      { label: "Images" },
      { label: "Subject" },
      { label: "Error" },
    ],
    rows.map((row) => [
      String(row.discussion_id),
      row.ok ? "Yes" : "No",
      row.posts === undefined ? "" : String(row.posts),
      row.images === undefined ? "" : String(row.images),
      row.subject,
      row.error ?? "",
    ]),
    { title: `Forum ${forumCmid} · Discussion Check` },
  );
}

export function formatAuthStatus(status: AuthStatus): string {
  return renderKeyValueTable([
    ["Site", status.base_url],
    ["Cached session", status.session_cached ? "yes" : "no"],
    ["Cache age", status.cache_age_minutes === null ? "" : `${status.cache_age_minutes} min`],
    ["Session alive", status.session_alive === null ? (status.session_cached ? "unknown" : "") : status.session_alive ? "yes" : "no"],
    ["Server timeout in", formatDuration(status.session_time_remaining_seconds)],
    ["Keepalive agent", status.keepalive_installed ? `installed (${status.keepalive_plist_path})` : "not installed"],
  ], { title: "Authentication" });
}

export function formatKeepaliveResult(result: KeepaliveRunResult): string {
  switch (result.status) {
    case "renewed":
      return `Session renewed${result.time_remaining_seconds ? `; server timeout in ${formatDuration(result.time_remaining_seconds)}` : ""}`;
    case "reauthenticated":
      return "Session was expired; re-authenticated from browser/okta cookies";
    case "expired":
      return "Session expired and could not be renewed. Log in to Moodle in your browser or run: moodle auth login";
    case "no_session":
      return "No cached session to renew. Run any moodle command once, or: moodle auth login";
    case "unreachable":
      return "Could not reach the Moodle site; session state unchanged";
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "";
  }
  if (seconds < 90) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes} min`;
  }
  return `${(minutes / 60).toFixed(1)} h`;
}

function preview(value: string, maxLen = 100): string {
  const cleaned = value.split(/\s+/).filter(Boolean).join(" ");
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 1)}…`;
}

function formatTimestamp(value: number): string {
  if (value <= 0) return "-";
  const date = new Date(value * 1_000);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
