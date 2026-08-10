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

export function formatUser(user: UserInfo): string {
  return formatKeyValues([
    ["User", user.fullname],
    ["Username", user.username],
    ["User ID", String(user.userid)],
    ["Site", user.sitename],
    ["URL", user.siteurl],
    ["Language", user.lang ?? ""],
  ]);
}

export function formatCourses(courses: Course[]): string {
  return formatColumns([["ID", "Short Name", "Full Name"], ...courses.map((course) => [String(course.id), course.shortname, course.fullname])]);
}

export function formatCourseSections(sections: Section[]): string {
  const lines = ["Course"];
  for (const section of sections) {
    lines.push(`  ${section.name || `Section ${section.section}`}${section.visible ? "" : " (hidden)"}`);
    if (!section.activities.length) {
      lines.push("    No activities");
      continue;
    }
    for (const activity of section.activities) {
      lines.push(`    ${activity.name}${activity.visible ? "" : " (hidden)"} (${activity.modname})`);
    }
  }
  return lines.join("\n");
}

export function formatActivityList(value: Section[] | Activity[]): string {
  const activities = Array.isArray(value) && value[0] && "activities" in value[0]
    ? (value as Section[]).flatMap((section) => section.activities)
    : (value as Activity[]);
  return formatColumns([["ID", "Type", "Name"], ...activities.map((activity) => [String(activity.id), activity.modname, activity.name])]);
}

export function formatTodo(items: TodoItem[]): string {
  if (!items.length) {
    return "No upcoming items";
  }
  return formatColumns([
    ["Due", "Course", "Activity", "Type", "Action"],
    ...items.map((item) => [
      item.due_at ? String(item.due_at) : "-",
      item.course_name,
      item.activity_name || item.name,
      item.modname || item.event_type,
      item.actionable ? item.action_name : "",
    ]),
  ]);
}

export function formatAlerts(alerts: AlertSummary): string {
  const lines = [
    `Notifications: ${alerts.notification_count}`,
    `Unread notifications: ${alerts.unread_notification_count}`,
    `Direct messages: ${alerts.direct_message_count}`,
    `Unread direct messages: ${alerts.unread_direct_message_count}`,
  ];
  for (const notification of alerts.notifications) {
    lines.push(`${notification.created_pretty || notification.created_at} ${notification.short_subject || notification.subject}`);
  }
  return lines.join("\n");
}

export function formatGrades(grades: CourseGrades): string {
  return formatColumns([
    ["Item", "Grade", "Range", "Percent", "Feedback"],
    ...grades.items.map((item) => [item.name, item.grade, item.range, item.percentage, item.feedback]),
  ]);
}

export function formatActivityDetail(activity: ActivityDetail): string {
  const rows = Object.entries(activity)
    .filter(([, value]) => value !== "" && value !== undefined && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : String(value)] as [string, string]);
  return formatKeyValues(rows);
}

export function formatDownloadReceipt(receipt: DownloadReceipt): string {
  return formatKeyValues([
    ["File", receipt.file_path],
    ["Filename", receipt.filename],
    ["Bytes", String(receipt.bytes_written)],
    ["Content type", receipt.content_type],
    ["Source", receipt.source_url],
    ["Final URL", receipt.final_url],
  ]);
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
    return lines.join("\n");
  }

  for (const post of discussion.posts) {
    const marker = options.highlightPostId === post.id ? "*" : "-";
    lines.push("", `${marker} Post ${post.id}`);
    lines.push(`  Author: ${post.author.fullname || "-"}`);
    lines.push(`  When: ${post.created_pretty || (post.time_created ? String(post.time_created) : "-")}`);
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

  return lines.join("\n");
}

export function formatForumDiscussionRefs(forumCmid: number, refs: ForumDiscussionRef[]): string {
  const lines = [`Forum ${forumCmid}: Discussions`];
  if (!refs.length) {
    return `${lines[0]}\nNo discussions`;
  }
  for (const ref of refs) {
    lines.push([ref.id, ref.subject, ref.group_name, ref.url].filter(Boolean).join(" | "));
  }
  return lines.join("\n");
}

export function formatForumActivities(forums: ForumActivityRef[]): string {
  if (!forums.length) {
    return "Forums\nNo forums";
  }
  return [
    "Forums",
    ...forums.map((forum) => [forum.id, forum.name, forum.course_name, forum.course_id || "", forum.url].filter(Boolean).join(" | ")),
  ].join("\n");
}

export function formatForumSearchHits(hits: ForumSearchHit[]): string {
  if (!hits.length) {
    return "Forum Search\nNo matches";
  }
  return [
    "Forum Search",
    ...hits.map((hit) =>
      [
        hit.course_name,
        hit.forum_name,
        hit.discussion_subject,
        hit.discussion_id || "",
        hit.post_id || "",
        hit.matched_in,
        hit.author_name,
        hit.snippet || hit.discussion_subject,
        hit.url,
      ]
        .filter(Boolean)
        .join(" | "),
    ),
  ].join("\n");
}

export function formatForumCheckResults(forumCmid: number, rows: ForumCheckResult[]): string {
  const lines = [`Forum ${forumCmid}: Discussion Check (first ${rows.length})`];
  for (const row of rows) {
    lines.push(
      row.ok
        ? `${row.discussion_id} | Yes | ${row.posts ?? ""} | ${row.images ?? ""} | ${row.subject}`
        : `${row.discussion_id} | No | ${row.subject} | ${row.error ?? ""}`,
    );
  }
  return lines.join("\n");
}

export function formatAuthStatus(status: AuthStatus): string {
  return formatKeyValues([
    ["Site", status.base_url],
    ["Cached session", status.session_cached ? "yes" : "no"],
    ["Cache age", status.cache_age_minutes === null ? "" : `${status.cache_age_minutes} min`],
    ["Session alive", status.session_alive === null ? (status.session_cached ? "unknown" : "") : status.session_alive ? "yes" : "no"],
    ["Server timeout in", formatDuration(status.session_time_remaining_seconds)],
    ["Keepalive agent", status.keepalive_installed ? `installed (${status.keepalive_plist_path})` : "not installed"],
  ]);
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

function formatKeyValues(rows: Array<[string, string]>): string {
  const present = rows.filter(([, value]) => value);
  const width = Math.max(0, ...present.map(([key]) => key.length));
  return present.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
}

function formatColumns(rows: string[][]): string {
  if (!rows.length) {
    return "";
  }
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => (row[index] ?? "").length)));
  return rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()).join("\n");
}
