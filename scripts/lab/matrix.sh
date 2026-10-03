#!/usr/bin/env bash
# Runs `moodle coverage` from this checkout's dist/ against the lab under each variant and
# fails when a variant's result differs from what it must be. Run `npm run build` first.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LAB="${MOODLE_LAB_DIR:-$HOME/.cache/moodle-cli-lab}"
SERVICES="$LAB/moodle/lib/db/services.php"
failures=0

coverage() {
  local home; home="$(mktemp -d)"
  MOODLE_BASE_URL=http://127.0.0.1:8080 MOODLE_SESSION="$(cat "$LAB/session.txt")" MOODLE_NO_UPDATE_CHECK=1 HOME="$home" \
    node "$REPO/dist/moodle.js" coverage --no-cache --json || true
  rm -rf "$home"
}

# expect NAME "check=status ..." : every other check must pass.
expect() {
  local name=$1 allowed=$2 report
  report="$(coverage)"
  if node -e '
    const report = JSON.parse(process.argv[1]);
    const allowed = new Map(process.argv[2].split(" ").filter(Boolean).map(pair => pair.split("=")));
    const key = check => check.target ? `${check.name}(${check.target})` : check.name;
    const wrong = report.checks.filter(check => (allowed.get(key(check)) ?? (["ok", "fallback", "untested"].includes(check.status) ? check.status : "pass")) !== check.status);
    const missing = [...allowed].filter(([k, status]) => !report.checks.some(check => key(check) === k && check.status === status));
    console.log(`${process.argv[3].padEnd(16)} ${JSON.stringify(report.summary)}${wrong.length || missing.length ? `  UNEXPECTED: ${[...wrong.map(c => `${key(c)}=${c.status}: ${c.detail}`), ...missing.map(([k, s]) => `${k} should be ${s}`)].join("; ")}` : ""}`);
    process.exit(wrong.length || missing.length ? 1 : 0);
  ' "$report" "$allowed" "$name"; then :; else failures=$((failures + 1)); fi
}

ajax() { # ajax FUNCTION true|false
  node -e '
    const fs = require("node:fs"); const [file, name, on] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8"); const start = text.indexOf(`\x27${name}\x27 =>`); const end = text.indexOf("),", start);
    fs.writeFileSync(file, text.slice(0, start) + text.slice(start, end).replace(/(\x27ajax\x27\s*=>\s*)(true|false)/u, `$1${on}`) + text.slice(end));
  ' "$SERVICES" "$1" "$2"
  sleep 3 # opcache revalidates changed files every 2s
}

"$HERE/start.sh" >/dev/null
reset() { "$HERE/variant.sh" theme boost >/dev/null; "$HERE/variant.sh" lang en >/dev/null; "$HERE/variant.sh" strings off >/dev/null; "$HERE/login.sh" >/dev/null 2>&1; }
trap 'ajax core_courseformat_get_state true; ajax core_calendar_get_action_events_by_timesort true; reset' EXIT
reset

expect boost ""
"$HERE/variant.sh" theme classic >/dev/null; expect classic ""; "$HERE/variant.sh" theme boost >/dev/null
"$HERE/variant.sh" lang de >/dev/null; "$HERE/login.sh" >/dev/null 2>&1; expect german ""
"$HERE/variant.sh" lang en >/dev/null; "$HERE/login.sh" >/dev/null 2>&1
"$HERE/variant.sh" strings on >/dev/null; expect custom-string ""; "$HERE/variant.sh" strings off >/dev/null
ajax core_courseformat_get_state false; expect no-format-state ""; ajax core_courseformat_get_state true
ajax core_calendar_get_action_events_by_timesort false; expect no-calendar "due=fail home=partial"; ajax core_calendar_get_action_events_by_timesort true

echo "$failures variant(s) unexpected"
exit $((failures > 0))
