# Setup and Authentication

Read this file for installation, first-run configuration, browser-session reuse, or authentication recovery.

## Install

Prefer the published npm package:

```bash
npm install -g moodle-cli
moodle --version
```

Use `npx moodle-cli --help` for a one-off run. Existing PyPI users should migrate with:

```bash
uv tool uninstall moodle-cli
npm install -g moodle-cli
```

Standalone binaries are available from GitHub Releases for supported platforms.

## Configure the Moodle Site

Set `MOODLE_BASE_URL` to the Moodle site root, such as `https://school.example.edu`. A URL ending in `/login/index.php`, `/my/`, or another page is invalid.

For an interactive first run, allow the CLI to prompt for the root URL and save it under `~/.config/moodle-cli/config.yaml`.

## Authenticate

The CLI tries these session sources:

1. `MOODLE_SESSION`
2. A fresh local session cache
3. Supported browser cookies
4. `okta-auth-cli`

For automatic Okta login:

```bash
uv tool install okta-auth-cli
okta config
```

Validate setup with:

```bash
moodle user --json
```

Setup is complete when this returns the authenticated Moodle user.

## Keep the Session Alive

Moodle expires idle sessions server-side (often a few hours). To avoid re-running SSO logins:

```bash
moodle auth status --json              # cache freshness + server session state
moodle auth keepalive --json           # renew once (re-login from browser/okta cookies if expired)
moodle auth keepalive install          # macOS launch agent, renews every 30 min
moodle auth keepalive install --interval 15
moodle auth keepalive uninstall
moodle auth login --json               # extract a session; open the browser if needed
```

On Linux, schedule `moodle auth keepalive --json` with cron instead of `install`.

`moodle auth login` first checks local session sources. If none is valid, it opens Moodle's login page in the system browser and waits up to two minutes for the completed SSO/OAuth login.

## Recover Failures

- **No usable MoodleSession**: sign in to Moodle in a supported browser and retry; otherwise configure `okta-auth-cli` or provide `MOODLE_SESSION` through the environment.
- **Configured site is wrong**: correct `MOODLE_BASE_URL` or the saved `base_url`, then rerun `moodle user --json`.
- **Cached session expired**: run `moodle auth login`, or rerun with `--no-cache` once so the CLI reacquires a session.
- **Non-interactive config error**: set `MOODLE_BASE_URL`; a pipe cannot answer the first-run prompt.

## Manage the Private MCP Server

Use the lifecycle commands instead of asking the user to copy cookies, tokens, Wrangler commands, or client configuration:

```bash
moodle mcp deploy
moodle mcp status --json
moodle mcp login
moodle mcp connect
moodle mcp pair
moodle mcp remove
```

`moodle mcp deploy` validates the local Moodle session, deploys and verifies a private Cloudflare Worker, installs local renewal, and connects detected clients. The default bridge mode keeps the Bearer token out of client files. Use `moodle mcp login` when status reports `SESSION_EXPIRED`; use `moodle mcp deploy --repair` when Cloudflare authorization or managed deployment state needs repair.

`moodle mcp connect` covers clients that read a configuration file. Use `moodle mcp pair` for claude.ai and other hosted clients that authenticate with OAuth: it prints the connector URL and a one-time pairing code that expires in ten minutes, and the Worker refuses every authorization attempt while no pairing window is open. Read the code back to the user; never paste it into a web form yourself.

Never print or request the raw Moodle cookie, MCP access token, session sync token, or sesskey. An advanced operator may pipe a cookie directly to `moodle mcp session push --stdin`; do not place it in arguments or shell history.

### Managing private MCP access

Use `moodle mcp clients --json` to inspect OAuth clients, `moodle mcp revoke CLIENT_ID` to remove one client, or `moodle mcp revoke --all` to close all OAuth access, pending authorizations, and pairing windows. These use the owner's protected sync credential.

`moodle mcp deploy --rotate-token` invalidates previous static credentials and OAuth grants immediately. `moodle mcp deploy --rotate-key` re-encrypts and verifies the active session before retiring the previous encryption key. `moodle mcp deploy --repair` reconciles interrupted uploads using the live session revision. Rollback requires a compatible session schema and matching current keys/credentials; updates retain a static-bridge recovery release.

The Worker is pinned to its Moodle account. Do not reuse it for another account. Session records and local caches are encrypted; OS-protected credential storage is required. `--no-cache` bypasses reads and writes. Existing plaintext caches migrate when read, and managed removal deletes the matching authentication cache. Keep the owner's device and Cloudflare account trusted: the running Worker must decrypt the cookie to call Moodle.
