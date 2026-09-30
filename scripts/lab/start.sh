#!/usr/bin/env bash
# Start (or stop / report on) the lab's PostgreSQL cluster and PHP built-in web server.
# Usage: start.sh [start|stop|status]     (default: start; idempotent)
set -euo pipefail

LAB="${MOODLE_LAB_DIR:-$HOME/.cache/moodle-cli-lab}"
HOST=127.0.0.1
PORT="${MOODLE_PORT:-8080}"
URL="http://$HOST:$PORT/login/index.php"

pg_online() { pg_lsclusters | awk '$1 == 16 && $2 == "main" { print $4 }' | grep -q '^online$'; }
web_up()    { curl -sf -o /dev/null --max-time 5 "$URL"; }

case "${1:-start}" in
  start)
    if ! pg_online; then
      service postgresql start >/dev/null 2>&1 || pg_ctlcluster 16 main start
    fi
    for _ in $(seq 1 30); do pg_isready -q -h "$HOST" -p 5432 && break; sleep 1; done
    pg_isready -h "$HOST" -p 5432

    if web_up; then
      echo "web server already answering on $URL"
    else
      # PHP_CLI_SERVER_WORKERS lets Moodle's self-requests and parallel test clients overlap.
      # setsid + nohup detach it from the calling shell so it survives the session.
      PHP_CLI_SERVER_WORKERS=4 setsid nohup php \
        -d max_input_vars=5000 -d memory_limit=512M -d opcache.enable_cli=1 -d opcache.memory_consumption=256 \
        -S "$HOST:$PORT" -t "$LAB/moodle" >>"$LAB/server.log" 2>&1 </dev/null &
      echo $! >"$LAB/server.pid"
      for _ in $(seq 1 30); do web_up && break; sleep 1; done
      web_up && echo "web server up on $URL (pid $(cat "$LAB/server.pid"))" || { echo "web server failed to start; see $LAB/server.log" >&2; exit 1; }
    fi
    ;;
  stop)
    # The server was started under setsid, so its pid is also its process-group id: signalling the
    # group stops the master and its workers without a `pkill -f` that could match unrelated shells.
    if [[ -f "$LAB/server.pid" ]] && kill -0 "$(cat "$LAB/server.pid")" 2>/dev/null; then
      kill -- "-$(cat "$LAB/server.pid")" 2>/dev/null || kill "$(cat "$LAB/server.pid")" || true
    fi
    for _ in $(seq 1 10); do web_up || break; sleep 1; done
    echo "web server stopped (PostgreSQL left running; 'pg_ctlcluster 16 main stop' to stop it)"
    ;;
  status)
    pg_online && echo "postgresql: online" || echo "postgresql: DOWN"
    web_up && echo "web: up ($URL)" || echo "web: DOWN"
    ;;
  *) echo "usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac
