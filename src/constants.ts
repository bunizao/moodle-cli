export const PACKAGE_NAME = "moodle-cli";
export const NPM_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const GITHUB_RELEASES_URL = "https://github.com/bunizao/moodle-cli/releases/latest";

export const AJAX_SERVICE_PATH = "/lib/ajax/service.php";
export const DASHBOARD_PATH = "/my/";
export const COURSE_PATH = "/course/view.php";
export const ASSIGN_VIEW_PATH = "/mod/assign/view.php";
export const QUIZ_VIEW_PATH = "/mod/quiz/view.php";
export const RESOURCE_VIEW_PATH = "/mod/resource/view.php";
export const URL_VIEW_PATH = "/mod/url/view.php";
export const PAGE_VIEW_PATH = "/mod/page/view.php";
export const FOLDER_VIEW_PATH = "/mod/folder/view.php";
export const FORUM_DISCUSS_PATH = "/mod/forum/discuss.php";
export const FORUM_VIEW_PATH = "/mod/forum/view.php";
export const GRADE_REPORT_INDEX_PATH = "/grade/report/index.php";
export const GRADE_REPORT_OVERVIEW_PATH = "/grade/report/overview/index.php";
export const GRADE_REPORT_PATH = "/grade/report/user/index.php";
export const LOGIN_PATH = "/login/index.php";

export const FUNC_GET_SITE_INFO = "core_webservice_get_site_info";
export const FUNC_GET_COURSES = "core_enrol_get_users_courses";
export const FUNC_GET_COURSES_BY_TIMELINE = "core_course_get_enrolled_courses_by_timeline_classification";
export const FUNC_GET_COURSE_CONTENTS = "core_course_get_contents";
export const FUNC_GET_COURSE_MODULE = "core_course_get_course_module";
export const FUNC_GET_ACTION_EVENTS = "core_calendar_get_action_events_by_timesort";
export const FUNC_GET_POPUP_NOTIFICATIONS = "message_popup_get_popup_notifications";
export const FUNC_GET_CONVERSATION_COUNTS = "core_message_get_conversation_counts";
export const FUNC_GET_UNREAD_CONVERSATION_COUNTS = "core_message_get_unread_conversation_counts";
export const FUNC_GET_DISCUSSION_POSTS = "mod_forum_get_discussion_posts";
export const FUNC_SESSION_TOUCH = "core_session_touch";
export const FUNC_SESSION_TIME_REMAINING = "core_session_time_remaining";

export const CONFIG_FILENAME = "config.yaml";
export const CONFIG_DIR_NAME = ".config/moodle-cli";
export const CACHE_DIR_NAME = ".cache/moodle-cli";
export const SESSION_CACHE_FILENAME = "session.json";
export const DEFAULT_SESSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const KEEPALIVE_LAUNCH_AGENT_LABEL = "com.moodle-cli.keepalive";
export const KEEPALIVE_DEFAULT_INTERVAL_MINUTES = 30;
export const KEEPALIVE_LOG_FILENAME = "keepalive.log";

export const ENV_MOODLE_SESSION = "MOODLE_SESSION";
export const ENV_MOODLE_BASE_URL = "MOODLE_BASE_URL";
export const ENV_MOODLE_URL = "MOODLE_URL";
export const ENV_MOODLE_CONFIG = "MOODLE_CONFIG";
export const ENV_MOODLE_TOKEN = "MOODLE_TOKEN";

export const MOODLE_SESSION_COOKIE_PREFIX = "MoodleSession";
export const OKTA_AUTH_URL = "https://github.com/bunizao/okta-auth";
export const OKTA_AUTH_INSTALL_COMMAND = "uv tool install okta-auth-cli";
export const OKTA_AUTH_CONFIG_COMMAND = "okta config";
