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

// Moodle's built-in mobile app bridge. `launch.php` mints a Web Service token
// for an already-authenticated browser session; the autologin pair then trades
// that durable token for a fresh MoodleSession cookie with no browser at all.
export const MOBILE_LAUNCH_PATH = "/admin/tool/mobile/launch.php";
export const MOBILE_AUTOLOGIN_PATH = "/admin/tool/mobile/autologin.php";
export const WEBSERVICE_REST_PATH = "/webservice/rest/server.php";
export const SERVICE_NOLOGIN_PATH = "/lib/ajax/service-nologin.php";
export const MOBILE_SERVICE_SHORTNAME = "moodle_mobile_app";
// A URL scheme launch.php redirects the token to. It never resolves in a real
// browser; we only read it back over the wire, so any private scheme works.
export const MOBILE_URL_SCHEME = "moodlecli";
// tool_mobile gates the autologin functions on a MoodleMobile user agent.
export const MOBILE_USER_AGENT = "MoodleMobile 4.5.0 (moodle-cli)";
export const FUNC_MOBILE_PUBLIC_CONFIG = "tool_mobile_get_public_config";
export const FUNC_MOBILE_AUTOLOGIN_KEY = "tool_mobile_get_autologin_key";

export const FUNC_GET_SITE_INFO = "core_webservice_get_site_info";
export const FUNC_GET_COURSES = "core_enrol_get_users_courses";
export const FUNC_GET_COURSES_BY_TIMELINE = "core_course_get_enrolled_courses_by_timeline_classification";
export const FUNC_GET_COURSE_CONTENTS = "core_course_get_contents";
export const FUNC_GET_COURSE_FORMAT_STATE = "core_courseformat_get_state";
export const FUNC_GET_COURSE_MODULE = "core_course_get_course_module";
export const FUNC_GET_ACTION_EVENTS = "core_calendar_get_action_events_by_timesort";
export const FUNC_GET_ACTION_EVENTS_BY_COURSE = "core_calendar_get_action_events_by_course";
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
// A Chromium user-data-dir the CLI owns outright, so remote debugging is allowed
// (Chrome 136+ refuses it on the real profile) and reads never touch the user's
// browser on disk. Kept out of the config dir so `auth logout` can wipe it.
export const CDP_PROFILE_DIR_NAME = ".cache/moodle-cli/browser-profile";
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

export const WRANGLER_VERSION = "4.131.0";
