export interface UserInfo {
  userid: number;
  username: string;
  fullname: string;
  sitename: string;
  siteurl: string;
  lang?: string;
}

export interface PageContext {
  sesskey: string;
  user_info: UserInfo;
}

export interface Course {
  id: number;
  shortname: string;
  fullname: string;
  category: number;
  visible: boolean;
  startdate: number;
  enddate?: number;
}

export interface Activity {
  id: number;
  name: string;
  modname: string;
  url: string;
  visible: boolean;
  description: string;
}

export interface Section {
  id: number;
  name: string;
  section: number;
  visible: boolean;
  summary: string;
  activities: Activity[];
}

export interface TodoItem {
  id: number;
  name: string;
  activity_name: string;
  modname: string;
  course_id: number;
  course_name: string;
  due_at: number;
  overdue: boolean;
  actionable: boolean;
  action_name: string;
  action_url: string;
  url: string;
  event_type: string;
  course_progress?: number;
}

export interface AlertNotification {
  id: number;
  subject: string;
  short_subject: string;
  event_type: string;
  component: string;
  created_at: number;
  created_pretty: string;
  read: boolean;
  context_url: string;
  context_name: string;
}

export interface AlertSummary {
  notifications: AlertNotification[];
  notification_count: number;
  unread_notification_count: number;
  starred_message_count: number;
  direct_message_count: number;
  group_message_count: number;
  self_message_count: number;
  unread_starred_message_count: number;
  unread_direct_message_count: number;
  unread_group_message_count: number;
  unread_self_message_count: number;
}

export interface Overview {
  user: UserInfo;
  courses: Course[];
  todo: TodoItem[];
  alerts?: AlertSummary;
  errors: string[];
}

export interface GradeItem {
  name: string;
  item_type: string;
  grade: string;
  range: string;
  percentage: string;
  weight: string;
  contribution: string;
  feedback: string;
  url: string;
  status: string;
}

export interface CourseGrades {
  course_id: number;
  course_name: string;
  learner_name: string;
  total_grade: string;
  total_range: string;
  total_percentage: string;
  items: GradeItem[];
}

export interface Assignment {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  due_pretty: string;
  submission_status: string;
  grading_status: string;
  time_remaining: string;
  grade: string;
  url: string;
}

export interface Quiz {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  opens_pretty: string;
  closes_pretty: string;
  attempts_allowed: string;
  availability: string;
  grade: string;
  url: string;
}

export interface FileEntry {
  name: string;
  url: string;
  requires_authentication: boolean;
}

export interface Resource {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  target_name: string;
  target_url: string;
  file_entries: FileEntry[];
  url: string;
}

export interface Link {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  target_url: string;
  url: string;
}

export interface Page {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  content_text: string;
  url: string;
}

export interface Folder {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  files: string[];
  file_entries: FileEntry[];
  url: string;
}

export type ActivityDetail = Assignment | Quiz | Resource | Link | Page | Folder | Activity;

export interface ForumPostAuthor {
  id: number;
  fullname: string;
  profile_url: string;
  profile_image_url: string;
}

export interface ForumPost {
  id: number;
  discussion_id: number;
  subject: string;
  message_html: string;
  message_text: string;
  image_urls: string[];
  links: Array<{ text: string; url: string }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  author: ForumPostAuthor;
  parent_id: number;
  time_created: number;
  time_modified: number;
  created_pretty: string;
  unread: boolean;
  is_deleted: boolean;
  is_private_reply: boolean;
  url: string;
  reply_url: string;
}

export interface ForumDiscussion {
  id: number;
  subject: string;
  course_id: number;
  forum_id: number;
  group_id: number;
  group_name: string;
  url: string;
  posts: ForumPost[];
}

export interface ForumDiscussionRef {
  id: number;
  subject: string;
  group_id: number;
  group_name: string;
  url: string;
}

export interface ForumActivityRef {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  url: string;
}

export interface ForumSearchHit {
  course_id: number;
  course_name: string;
  forum_id: number;
  forum_name: string;
  group_id: number;
  group_name: string;
  discussion_id: number;
  discussion_subject: string;
  post_id: number;
  author_name: string;
  matched_in: string;
  snippet: string;
  unread: boolean;
  time_created: number;
  url: string;
}

export interface ForumCheckResult {
  discussion_id: number;
  subject: string;
  ok: boolean;
  posts?: number;
  images?: number;
  error?: string;
}
