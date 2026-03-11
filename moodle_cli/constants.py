"""Default values and API paths."""

PACKAGE_NAME = "moodle-cli"
PYPI_JSON_URL = f"https://pypi.org/pypi/{PACKAGE_NAME}/json"

AJAX_SERVICE_PATH = "/lib/ajax/service.php"
DASHBOARD_PATH = "/my/"
COURSE_PATH = "/course/view.php"
GRADE_REPORT_INDEX_PATH = "/grade/report/index.php"
GRADE_REPORT_OVERVIEW_PATH = "/grade/report/overview/index.php"
GRADE_REPORT_PATH = "/grade/report/user/index.php"
LOGIN_PATH = "/login/index.php"

# Moodle AJAX function names
FUNC_GET_SITE_INFO = "core_webservice_get_site_info"
FUNC_GET_COURSES = "core_enrol_get_users_courses"
FUNC_GET_COURSES_BY_TIMELINE = "core_course_get_enrolled_courses_by_timeline_classification"
FUNC_GET_COURSE_CONTENTS = "core_course_get_contents"
FUNC_GET_ACTION_EVENTS = "core_calendar_get_action_events_by_timesort"
FUNC_GET_POPUP_NOTIFICATIONS = "message_popup_get_popup_notifications"
FUNC_GET_CONVERSATION_COUNTS = "core_message_get_conversation_counts"
FUNC_GET_UNREAD_CONVERSATION_COUNTS = "core_message_get_unread_conversation_counts"

# Config file locations (checked in order)
CONFIG_FILENAME = "config.yaml"
CONFIG_DIR = "~/.config/moodle-cli"

# Environment variable names
ENV_MOODLE_SESSION = "MOODLE_SESSION"
ENV_MOODLE_BASE_URL = "MOODLE_BASE_URL"
