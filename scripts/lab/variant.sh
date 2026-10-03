#!/usr/bin/env bash
# Switch lab variants used to exercise the CLI against different Moodle renderings.
#   variant.sh theme boost|classic
#   variant.sh lang <code> [username]     (default user: student1; e.g. de, en)
#   variant.sh strings on|off             (sample local override of mod_assign 'submissionstatus')
#   variant.sh status
# Every switch purges caches. Language is copied into a session at login, so run login.sh
# again after `lang` before expecting the new language (existing session cookies keep the old one).
set -euo pipefail

LAB="${MOODLE_LAB_DIR:-$HOME/.cache/moodle-cli-lab}"
PHP=(php -d max_input_vars=5000)
cfg()   { (cd "$LAB/moodle" && "${PHP[@]}" admin/cli/cfg.php "$@"); }
purge() { (cd "$LAB/moodle" && "${PHP[@]}" admin/cli/purge_caches.php); }
sql()   { PGPASSWORD=moodlepw psql -h 127.0.0.1 -U moodle -d moodle -qtAc "$1"; }
usage() { sed -n '2,8p' "$0" >&2; exit 2; }

case "${1:-status}" in
  theme)
    [[ "${2:-}" =~ ^(boost|classic)$ ]] || usage
    cfg --name=theme --set="$2"
    purge
    echo "theme=$(cfg --name=theme)"
    ;;
  lang)
    code="${2:-}"; user="${3:-student1}"
    [[ "$code" =~ ^[a-z]{2,3}(_[a-z0-9]+)?$ && "$user" =~ ^[a-z0-9_.-]+$ ]] || usage
    if [[ "$code" != en && ! -f "$LAB/moodledata/lang/$code/langconfig.php" ]]; then
      mkdir -p "$LAB/moodledata/lang"
      tmp="$(mktemp --suffix=.zip)"
      curl -fsSL -o "$tmp" "https://download.moodle.org/download.php/direct/langpack/5.0/$code.zip"
      unzip -q -o "$tmp" -d "$LAB/moodledata/lang/"
      rm -f "$tmp"
    fi
    sql "UPDATE mdl_user SET lang='$code' WHERE username='$user'"
    purge
    echo "$user lang=$(sql "SELECT lang FROM mdl_user WHERE username='$user'") (re-run login.sh $user)"
    ;;
  strings)
    dir="$LAB/moodledata/lang/en_local"
    case "${2:-}" in
      on)
        mkdir -p "$dir"
        printf '%s\n' '<?php' "defined('MOODLE_INTERNAL') || die();" \
          "\$string['submissionstatus'] = 'Status of your work';" >"$dir/assign.php"
        purge ;;
      off)
        rm -f "$dir/assign.php"; rmdir "$dir" 2>/dev/null || true
        purge ;;
      *) usage ;;
    esac
    echo "strings override: $([[ -f "$dir/assign.php" ]] && echo on || echo off)"
    ;;
  status)
    echo "theme=$(cfg --name=theme)"
    sql "SELECT username || ' lang=' || lang FROM mdl_user WHERE username IN ('student1','teacher1','admin') ORDER BY 1"
    echo "langpacks: $(ls "$LAB/moodledata/lang" 2>/dev/null | tr '\n' ' ')"
    ;;
  *) usage ;;
esac
