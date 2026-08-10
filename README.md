# moodle-cli

Terminal-first CLI for Moodle LMS that reuses an authenticated browser session. No Moodle API token required.

## Features

- Reuses `MoodleSession` from `okta-auth`, your browser, or `MOODLE_TOKEN`
- Uses Moodle AJAX APIs and falls back to authenticated page scraping when needed
- Lists courses, deadlines, alerts, activities, grades, and forum discussions
- Streams authenticated Moodle resources to explicit local file paths without implicit overwrite
- Runs locally over stdio or deploys a private read-only MCP server to Cloudflare Workers
- Agent-friendly JSON/YAML output, field selection, and stable exit codes

## Install

Requires Node.js 22 or newer.

```bash
npm i -g moodle-cli
```

Run without installing:

```bash
npx moodle-cli --help
```

Standalone binaries are attached to GitHub Releases for macOS arm64 and Linux x64.

### Existing PyPI Users

The TypeScript CLI keeps the same config file and environment variables as the Python package. Migrate with:

```bash
uv tool uninstall moodle-cli
npm i -g moodle-cli
```

`~/.config/moodle-cli/config.yaml`, `MOODLE_BASE_URL`, and legacy `MOODLE_SESSION` remain compatible.

## Authentication

Use one of:

- `okta-auth-cli` configured for your Moodle site
- an active Moodle browser session
- a `MOODLE_TOKEN` environment variable containing a `MoodleSession` cookie value

Optional Okta setup:

```bash
npm i -g okta-auth-cli
okta config
```

On first run, if no `base_url` is configured, the CLI prompts for the Moodle root URL and saves it to `~/.config/moodle-cli/config.yaml`:

```yaml
base_url: https://school.example.edu
```

Use a root URL only, not `/login/index.php` or `/my/`.

Set `MOODLE_CONFIG` to use a different config file. `MOODLE_URL` remains a deprecated fallback for `MOODLE_BASE_URL` and prints a warning. `MOODLE_SESSION` remains a compatibility fallback for `MOODLE_TOKEN`.

### Session Keepalive

Moodle expires idle sessions server-side, which normally forces a fresh SSO login. The CLI can renew the session in the background instead:

```bash
moodle auth status               # cache freshness + server session state
moodle auth keepalive            # renew once; re-login from browser/okta cookies if expired
moodle auth keepalive install    # macOS launch agent, renews every 30 min
moodle auth login                # extract a fresh session; open the browser if needed
```

`moodle auth login` first checks the configured environment, local browser profiles, and stored `okta-auth` cookies. If none contains a valid Moodle session, it opens Moodle's login page in the system browser and waits up to two minutes for the completed SSO/OAuth login.

On Linux, add a cron entry: `*/30 * * * * moodle auth keepalive --json`.

## Managed MCP

Deploy a private Moodle MCP server with the active local Moodle and Wrangler sessions:

```bash
moodle mcp deploy
```

The command validates Moodle access, creates two private credentials, deploys a candidate Worker, uploads an encrypted Moodle session, verifies MCP and Moodle readiness, installs local renewal, and connects detected clients. Raw tokens and cookies are stored in the operating system credential store or a user-protected local fallback (`0600` on macOS/Linux and CurrentUser DPAPI on Windows); they are not printed or written into the project.

Primary lifecycle commands:

```bash
moodle mcp status
moodle mcp login
moodle mcp connect
moodle mcp remove
```

The default client connection uses `moodle mcp bridge`, so client configuration contains no Bearer token. Use `moodle mcp connect CLIENT --mode remote` only for clients that support authenticated remote MCP headers. `moodle mcp login` is the interactive recovery path when Moodle or the identity provider expires the remote session.

The Worker exposes public liveness at `/healthz`; `/readyz`, session replacement, and Moodle MCP calls require their corresponding Bearer credentials. Alpha version `0.7.0-alpha.0` supports MCP `2026-07-28` and stateless compatibility for `2025-11-25`.

## Usage

```bash
moodle --help
moodle user
moodle alerts
moodle todo
moodle overview
moodle units
moodle units show 34637
moodle activities 34637
moodle activities show 91234
moodle download 91234 --dest './Course/Week 03/slides.pdf' --json
moodle grades 34637
moodle forums 34637
moodle threads show 9001
moodle https://school.example.edu/course/view.php?id=34637
moodle https://school.example.edu/mod/forum/discuss.php?d=9001#p9101 --json
moodle skills
moodle skills generate
moodle skills add
moodle mcp status
```

Supported Moodle URLs can be passed as the first argument. The CLI routes forum discussion, forum view, assignment, quiz, resource, link, page, folder, course, and grade report URLs to the shortest matching command.

### File Downloads

Download one resource activity or authenticated Moodle file URL:

```bash
moodle download 91234
moodle download 'https://school.example.edu/mod/resource/view.php?id=91234' --dest './Course/Week 03/slides.pdf'
moodle dl 'https://school.example.edu/pluginfile.php/123/mod_resource/content/1/slides.pdf'
```

`download` is the canonical command and `dl` is its alias. `--dest` is the exact local file path; when omitted, the CLI uses the upstream filename in the current directory. Existing destinations fail with a usage error. `--force` atomically replaces the exact destination after the complete response has been streamed to a same-directory temporary file.

Resource and folder activity details expose `file_entries`. Folders are not downloaded recursively: inspect the folder with `moodle activities show ID --json`, choose entries, and run one download command per file. The MCP server exposes the same file metadata through `get_activity`, but intentionally has no local-write tool because a remote Worker cannot write to the MCP client's filesystem.

Successful downloads return `file_path`, `filename`, `bytes_written`, `content_type`, `source_url`, and `final_url`. Validate the receipt and saved file rather than treating exit code zero alone as proof of valid content.

## Agent Output Contract

JSON-capable commands support:

- `--json`: write JSON to stdout
- `--yaml`: write YAML to stdout
- `--table`: force human output
- `--fields a,b,c`: keep only listed top-level fields; arrays apply the filter per item
- `-o, --output FILE`: write command output or a download receipt to a file; this never selects the downloaded file path

When stdout is not a TTY, the CLI defaults to JSON. `--table` overrides that.

Invalid `--fields` values fail as usage errors and list valid fields.

With JSON output enabled, errors are one parseable JSON line on stderr:

```json
{"ok":false,"error":{"code":"auth","message":"...","hint":"..."},"exit_code":3}
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Usage error |
| 3 | Authentication error |
| 4 | Requested course, activity, forum, or discussion was not found |
| 5 | Moodle rejected a well-formed request |

## Updates

npm installs update with:

```bash
npm install -g moodle-cli@latest
```

Standalone binaries print the latest GitHub Release URL instead of modifying themselves.

## Agent Skill

Install the bundled agent skill:

```bash
npx skills add https://github.com/bunizao/moodle-cli
```

The CLI alias delegates to the same command:

```bash
moodle skills add
```

`SKILL.md` routes agents to focused guidance under `references/`; the exact command and output references remain generated from the CLI. The normalized command behavior comes from the published `@bunizao/cli-kit` npm package (`^0.1.0`).
