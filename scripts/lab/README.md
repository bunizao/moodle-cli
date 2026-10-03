# Moodle lab

A throwaway Moodle 5.0 with known contents, for checking `moodle coverage` and the page readers against a real site. Nothing here runs in `npm test`.

Needs PostgreSQL 16, PHP 8.2–8.4 (pgsql, intl, zip, gd, curl, mbstring, xml, sodium), and root for `su postgres`. The lab lives in `$MOODLE_LAB_DIR` (default `~/.cache/moodle-cli-lab`) and serves `http://127.0.0.1:8080`; use that exact host.

```bash
scripts/lab/install.sh      # download, install, generate data, log in (about 70 s); rerun to start over
npm run build && scripts/lab/matrix.sh   # every variant; exits non-zero when a result is not what it must be
scripts/lab/start.sh        # after a container restart: PostgreSQL and the web server
```

- `generate.php` builds two courses holding every activity type the readers handle: a graded submission, a finished quiz attempt, forum discussions, and one restricted and one hidden activity. It writes `$MOODLE_LAB_DIR/ground-truth.json`, and ids change on every run.
- `login.sh [user [password]]` signs in through the login form and writes the session to `$MOODLE_LAB_DIR/session.txt`. The default user is `student1`.
- `variant.sh theme boost|classic`, `variant.sh lang de|en` (then `login.sh` again, since a session keeps its language), `variant.sh strings on|off` (a site-customised "Submission status").
- `verify.sh` is a curl smoke test of the lab itself.

`matrix.sh` also switches services off for AJAX by editing the lab's `lib/db/services.php`, which Moodle reads on every call. It restores them on exit.

Users: `admin` / `Admin#2026lab`, `student1` / `Student#2026lab`, `teacher1` / `Teacher#2026lab`. They exist only in the lab.
