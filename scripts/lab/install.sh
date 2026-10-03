#!/usr/bin/env bash
# Installs a throwaway Moodle 5.0 into $MOODLE_LAB_DIR (default ~/.cache/moodle-cli-lab) on the
# local PostgreSQL 16, serves it on http://127.0.0.1:8080 and fills it with the lab data.
# Needs PHP 8.2-8.4 with pgsql, intl, zip, gd, curl, mbstring, xml and sodium. Rerunning
# starts from an empty site: the lab's database and moodledata are dropped first.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="${MOODLE_LAB_DIR:-$HOME/.cache/moodle-cli-lab}"
PHP=(php -d max_input_vars=5000)
mkdir -p "$LAB"

if [[ ! -f "$LAB/moodle/version.php" ]]; then
  curl -fsSL -o "$LAB/moodle.tgz" https://download.moodle.org/download.php/direct/stable500/moodle-latest-500.tgz
  tar -xzf "$LAB/moodle.tgz" -C "$LAB" && rm "$LAB/moodle.tgz"
fi

"$HERE/start.sh" stop >/dev/null 2>&1 || true
service postgresql start >/dev/null 2>&1 || pg_ctlcluster 16 main start
for _ in $(seq 1 30); do pg_isready -q -h 127.0.0.1 && break; sleep 1; done
as_postgres() { su postgres -c "psql -qtAc \"$1\""; }
as_postgres "DROP DATABASE IF EXISTS moodle"
[[ "$(as_postgres "SELECT 1 FROM pg_roles WHERE rolname='moodle'")" == 1 ]] || as_postgres "CREATE ROLE moodle LOGIN PASSWORD 'moodlepw'"
as_postgres "CREATE DATABASE moodle OWNER moodle ENCODING 'UTF8' TEMPLATE template0"

rm -rf "$LAB/moodledata" "$LAB/moodle/config.php" && mkdir -m 777 "$LAB/moodledata"
(cd "$LAB/moodle" && "${PHP[@]}" admin/cli/install.php --non-interactive --agree-license \
  --wwwroot=http://127.0.0.1:8080 --dataroot="$LAB/moodledata" --dbtype=pgsql --dbhost=127.0.0.1 \
  --dbname=moodle --dbuser=moodle --dbpass=moodlepw --prefix=mdl_ --fullname="Lab Moodle" --shortname=lab \
  --adminuser=admin --adminpass='Admin#2026lab' --adminemail=admin@example.com >"$LAB/install.log")
# The lab has no mail server; without these, Moodle throws while generating the forum posts.
sed -i "s#^require_once(__DIR__ . '/lib/setup.php');#\$CFG->noemailever = true;\n\$CFG->noreplyaddress = 'noreply@example.com';\n&#" "$LAB/moodle/config.php"

"$HERE/start.sh"
MOODLE_LAB_DIR="$LAB" "${PHP[@]}" "$HERE/generate.php"
"$HERE/login.sh" >/dev/null
echo "Lab ready at http://127.0.0.1:8080; ground truth in $LAB/ground-truth.json"
