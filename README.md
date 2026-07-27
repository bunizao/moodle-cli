# moodle-cli

Terminal-first CLI for Moodle LMS that reuses an authenticated browser session. No Moodle API token required.

## Features

- Reuses `MoodleSession` from `okta-auth`, your browser, or `MOODLE_SESSION`
- Uses Moodle AJAX APIs and falls back to authenticated page scraping when needed
- Lists courses, deadlines, alerts, activities, grades, and forum discussions
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

`~/.config/moodle-cli/config.yaml`, `MOODLE_BASE_URL`, and `MOODLE_SESSION` remain compatible.

## Authentication

Use one of:

- `okta-auth-cli` configured for your Moodle site
- an active Moodle browser session
- a `MOODLE_SESSION` environment variable

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

## Usage

```bash
moodle --help
moodle user
moodle alerts
moodle todo
moodle overview
moodle courses
moodle grades 34637
moodle activities 34637
moodle https://school.example.edu/course/view.php?id=34637
moodle https://school.example.edu/mod/forum/discuss.php?d=9001#p9101 --json
moodle skills
moodle skills generate
moodle skills add
moodle update
moodle update --check-only
```

Supported Moodle URLs can be passed as the first argument. The CLI routes forum discussion, forum view, assignment, quiz, resource, link, page, folder, course, and grade report URLs to the shortest matching command.

## Agent Output Contract

JSON-capable commands support:

- `--json`: write JSON to stdout
- `--yaml`: write YAML to stdout
- `--table`: force human output
- `--fields a,b,c`: keep only listed top-level fields; arrays apply the filter per item

When stdout is not a TTY, the CLI defaults to JSON. `--table` overrides that.

Invalid `--fields` values fail as usage errors and list valid fields.

With JSON output enabled, errors are one parseable JSON line on stderr:

```json
{"error":true,"code":"auth_failed","message":"...","hint":"..."}
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Authentication or configuration error |
| 3 | Usage error |
| 4 | Requested course, activity, forum, or discussion was not found |

## Updates

```bash
moodle update --check-only
moodle update --json
```

`moodle update` checks `https://registry.npmjs.org/moodle-cli/latest`. npm installs update with:

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

Regenerate the skill bundle from the command tree and source templates:

```bash
npm run build
npm run skill:generate
git diff --exit-code -- SKILL.md references agents/openai.yaml
```

`SKILL.md` routes agents to focused guidance under `references/`; the exact command and output references remain generated from the CLI.

## Development

The project typechecks with TypeScript 7 and bundles the Node.js CLI with tsup/esbuild.

```bash
npm install
npm run check
npm test
npm run build
```
