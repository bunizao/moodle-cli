#!/usr/bin/env bash
# Smoke-test the lab against ground-truth.json using $LAB/session.txt (student1).
# Prints PASS/FAIL per check; exit status is the number of failures.
set -uo pipefail

LAB="${MOODLE_LAB_DIR:-$HOME/.cache/moodle-cli-lab}"
BASE="${MOODLE_BASE_URL:-http://127.0.0.1:8080}"
GT="$LAB/ground-truth.json"
SESSION="$(cat "$LAB/session.txt")"
COOKIE="Cookie: MoodleSession=$SESSION"
FAILS=0

check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $d"; else echo "FAIL  $d"; FAILS=$((FAILS + 1)); fi
}
get() { curl -sS -L -H "$COOKIE" "$BASE$1"; }

SID="$(jq -r '.student1_userid' "$GT")"
C1="$(jq -r '.courses[] | select(.shortname=="LAB101") | .id' "$GT")"
C2="$(jq -r '.courses[] | select(.shortname=="LAB202") | .id' "$GT")"
EZ="$(jq -r '.essay_zero.cmid' "$GT")"
ATT="$(jq -r '.quiz_attempt.attempt_id' "$GT")"
QCM="$(jq -r '.quiz_attempt.quiz_cmid' "$GT")"
SLIDES="$(jq -r '.courses[0].activities[] | select(.name=="Lecture Slides") | .files[0].pluginfile_path' "$GT")"

check "login page served"            bash -c "curl -sS '$BASE/login/index.php' | grep -q 'name=\"logintoken\"'"
MY="$(get /my/)"
check "/my/ loads as student1 (userId $SID)" grep -q "\"userId\":$SID" <<<"$MY"
COURSE="$(get "/course/view.php?id=$C1")"
for n in "Essay One" "Essay Zero" "Quiz One" "Lecture Slides" "Readings" "Course Website" "Welcome Page" "Locked Task" "General Discussion" "Announcements"; do
  check "course page lists '$n'" grep -q "$n" <<<"$COURSE"
done
not_grep() { ! grep -q "$1" <<<"$2"; }  # HTML pages exceed the 128KB argv limit, so pass them via a function
check "course page hides 'Hidden Page'" not_grep 'Hidden Page' "$COURSE"
ASSIGN="$(get "/mod/assign/view.php?id=$EZ")"
check "Essay Zero shows grade 8"          grep -Eq '8[.,]00(&nbsp;| )*/(&nbsp;| )*10[.,]00' <<<"$ASSIGN"
check "Essay Zero shows feedback comment" grep -q 'Good work' <<<"$ASSIGN"
REVIEW="$(get "/mod/quiz/review.php?attempt=$ATT&cmid=$QCM")"
check "quiz review shows question 1"      grep -q 'The Earth orbits the Sun' <<<"$REVIEW"
check "quiz review shows question 2"      grep -q 'Which planet is closest to the Sun' <<<"$REVIEW"
FIRST="$(curl -sS -H "$COOKIE" "$BASE$SLIDES" | head -c 4)"
check "slides.pdf starts with %PDF"       test "$FIRST" = "%PDF"

SESSKEY="$(grep -o '"sesskey":"[^"]*"' <<<"$MY" | head -n1 | cut -d'"' -f4)"
ajax() { # ajax <function> <json args>
  curl -sS -H "$COOKIE" -H 'Content-Type: application/json' \
    --data "[{\"index\":0,\"methodname\":\"$1\",\"args\":$2}]" \
    "$BASE/lib/ajax/service.php?sesskey=$SESSKEY&info=$1"
}
# core_enrol_get_users_courses (as named in the task) is NOT exposed to AJAX by stock Moodle 5.0
# (no 'ajax' => true in lib/db/services.php); the AJAX-enabled equivalent is the timeline classification call.
AJAX="$(ajax core_course_get_enrolled_courses_by_timeline_classification '{"classification":"all","limit":0,"offset":0}')"
check "AJAX core_course_get_enrolled_courses_by_timeline_classification ok" jq -e '.[0].error == false' <<<"$AJAX"
check "AJAX returns exactly LAB101 and LAB202" jq -e --argjson a "$C1" --argjson b "$C2" \
  '[.[0].data.courses[].id] | sort == ([$a, $b] | sort)' <<<"$AJAX"
AJAX2="$(ajax core_enrol_get_users_courses "{\"userid\":$SID}")"
check "AJAX core_enrol_get_users_courses -> servicenotavailable (expected on stock 5.0)" \
  jq -e '.[0].exception.errorcode == "servicenotavailable"' <<<"$AJAX2"

echo "failures: $FAILS"
exit "$FAILS"
