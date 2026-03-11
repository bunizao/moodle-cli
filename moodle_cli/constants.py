"""Default values and API paths."""

PACKAGE_NAME = "moodle-cli"
PYPI_JSON_URL = f"https://pypi.org/pypi/{PACKAGE_NAME}/json"

AJAX_SERVICE_PATH = "/lib/ajax/service.php"
DASHBOARD_PATH = "/my/"
COURSE_PATH = "/course/view.php"
LOGIN_PATH = "/login/index.php"

# Moodle AJAX function names
FUNC_GET_SITE_INFO = "core_webservice_get_site_info"
FUNC_GET_COURSES = "core_enrol_get_users_courses"
FUNC_GET_COURSES_BY_TIMELINE = "core_course_get_enrolled_courses_by_timeline_classification"
FUNC_GET_COURSE_CONTENTS = "core_course_get_contents"

# Config file locations (checked in order)
CONFIG_FILENAME = "config.yaml"
CONFIG_DIR = "~/.config/moodle-cli"

# Environment variable names
ENV_MOODLE_SESSION = "MOODLE_SESSION"
ENV_MOODLE_BASE_URL = "MOODLE_BASE_URL"
