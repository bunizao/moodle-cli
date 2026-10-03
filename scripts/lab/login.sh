#!/usr/bin/env bash
# Log in to the lab Moodle through the normal web login form and store the resulting
# MoodleSession cookie value (and nothing else) in a file.
#
# Usage: login.sh [username [password [outfile]]]
#   username  default: student1
#   password  default: the known lab password for student1/teacher1/admin
#   outfile   default: $LAB/session.txt
# Env: MOODLE_BASE_URL (default http://127.0.0.1:8080)
#
# Progress and the verification result go to stderr; stdout stays empty so the script
# can be composed. Exit status is non-zero if the login did not produce a real session.
set -euo pipefail

LAB="${MOODLE_LAB_DIR:-$HOME/.cache/moodle-cli-lab}"
BASE="${MOODLE_BASE_URL:-http://127.0.0.1:8080}"
USERNAME="${1:-student1}"
PASSWORD="${2:-}"
OUT="${3:-$LAB/session.txt}"

if [[ -z "$PASSWORD" ]]; then
  case "$USERNAME" in
    student1) PASSWORD='Student#2026lab' ;;
    teacher1) PASSWORD='Teacher#2026lab' ;;
    admin)    PASSWORD='Admin#2026lab' ;;
    *) echo "login.sh: no default password for '$USERNAME'; pass one as the 2nd argument" >&2; exit 2 ;;
  esac
fi

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

# 1. Login page: sets the pre-login MoodleSession cookie and carries the CSRF logintoken.
PAGE="$(curl -sS -c "$JAR" -b "$JAR" "$BASE/login/index.php")"
TOKEN="$(printf '%s' "$PAGE" | grep -o 'name="logintoken" value="[^"]*"' | head -n1 | sed 's/.*value="//; s/"$//')"
if [[ -z "$TOKEN" ]]; then
  echo "login.sh: no logintoken found on $BASE/login/index.php (is the server up?)" >&2
  exit 1
fi

# 2. Submit the form and follow the redirect chain (login -> testsession -> landing page).
FINAL_URL="$(curl -sS -L -o /dev/null -w '%{url_effective}' -c "$JAR" -b "$JAR" \
  --data-urlencode "username=$USERNAME" \
  --data-urlencode "password=$PASSWORD" \
  --data-urlencode "logintoken=$TOKEN" \
  --data-urlencode "anchor=" \
  "$BASE/login/index.php")"

# 3. Pick the last MoodleSession value from the jar (Moodle rotates it on login).
#    Netscape jar format: domain, flag, path, secure, expiry, name, value; HttpOnly lines carry a prefix.
SESSION="$(awk -F'\t' '$6 == "MoodleSession" { v = $7 } END { print v }' "$JAR")"
if [[ -z "$SESSION" ]]; then
  echo "login.sh: no MoodleSession cookie after login (landed on $FINAL_URL)" >&2
  exit 1
fi

# 4. Prove it is a real, logged-in session: /my/ must not bounce to the login page and
#    M.cfg must carry a non-guest userId.
MY="$(curl -sS -L -H "Cookie: MoodleSession=$SESSION" "$BASE/my/")"
UID_IN_PAGE="$(printf '%s' "$MY" | grep -o '"userId":[0-9]*' | head -n1 | cut -d: -f2 || true)"
if [[ -z "$UID_IN_PAGE" || "$UID_IN_PAGE" == "0" || "$UID_IN_PAGE" == "1" ]]; then
  echo "login.sh: login for '$USERNAME' failed (userId='${UID_IN_PAGE:-none}', landed on $FINAL_URL)" >&2
  exit 1
fi

# Cross-check against ground-truth.json when it knows this user.
if [[ -f "$LAB/ground-truth.json" ]] && command -v jq >/dev/null; then
  EXPECTED="$(jq -r --arg u "$USERNAME" '.users[$u].id // empty' "$LAB/ground-truth.json")"
  if [[ -n "$EXPECTED" && "$EXPECTED" != "$UID_IN_PAGE" ]]; then
    echo "login.sh: userId $UID_IN_PAGE does not match ground-truth id $EXPECTED for '$USERNAME'" >&2
    exit 1
  fi
fi

umask 077
printf '%s' "$SESSION" > "$OUT"
echo "login.sh: OK user=$USERNAME userId=$UID_IN_PAGE session written to $OUT" >&2
