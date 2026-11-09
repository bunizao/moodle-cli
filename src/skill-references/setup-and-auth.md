# Setup and Authentication

Read this file for installation, first-run configuration, browser-session reuse, or authentication recovery.

## Install

Use the standalone installer from the repository for a bundled runtime, or install the npm package:

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

When no browser cookie is readable, `moodle auth login` opens the Moodle sign-in
page and waits for the session to appear.

Sites behind Okta can use the okta-auth CLI (`okta`) instead, only when the user
asks for it:

```bash
moodle auth login --okta     # sign in through okta now and on every later renewal
moodle auth login --no-okta  # stop using okta
```

Without `--okta`, an installed `okta` is only read: its saved session for the site
is reused, and `okta login` never runs. Background renewal never runs `okta login`.
When Okta rejects the password, the CLI stops calling `okta login` until the user
fixes the credentials (`okta config`) and runs `moodle auth login --okta` again;
repeated attempts can lock the account.

Validate setup with:

```bash
moodle user --json
```

Setup is complete when this returns the authenticated Moodle user.

## Keep the Session Alive

Moodle expires idle sessions server-side (often a few hours). To avoid re-running SSO logins:

```bash
moodle auth status --json              # cache freshness + server session state
moodle auth keepalive --json           # renew once (re-login from browser cookies if expired)
moodle auth keepalive install          # macOS launch agent, renews every 30 min
moodle auth keepalive install --interval 15
moodle auth keepalive uninstall
moodle auth login --json               # extract a session; open the browser if needed
```

On Linux, schedule `moodle auth keepalive --json` with cron instead of `install`.

`moodle auth login` first checks local session sources. If none is valid, it opens Moodle's login page in the system browser and waits up to two minutes for the completed SSO/OAuth login.

## Recover Failures

- **No usable MoodleSession**: sign in to Moodle in a supported browser and retry, run `moodle auth login`, or provide `MOODLE_SESSION` through the environment.
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

### Set up from a cloud session

When there is no desktop browser to read a Moodle cookie from (a hosted sandbox or cloud agent), install the CLI and deploy without a local session. The sandbox needs network access to the npm registry, `api.cloudflare.com`, `dash.cloudflare.com` and `*.workers.dev`.

```bash
npm install -g moodle-cli
MOODLE_BASE_URL=https://moodle.example.edu moodle mcp deploy --remote-login --yes --json > deploy.json 2> deploy.log &
```

Run it in the background, because it waits for the user twice:

1. **Cloudflare.** Without a terminal, Wrangler signs in with the OAuth device grant, and `deploy.log` soon shows `Open https://dash.cloudflare.com/oauth2/device/verify?user_code=... and approve with code ...`. Give that link to the user; they approve in their own browser within five minutes. No API token is needed. An existing `CLOUDFLARE_API_TOKEN` is used instead when set.
2. **Moodle.** When the command exits, `deploy.json` holds `endpoint` and `setupUrl`. Give `setupUrl` to the user as it is: it carries a one-time pairing code valid for ten minutes, so never open it, fetch it, or paste it anywhere else. The user opens it, signs in to Moodle in the remote browser it shows (the Worker never sees what they type), and that Moodle account becomes the Worker's owner. Then they add `endpoint` as a custom connector and approve it, in one click from the same browser or through **Sign in with Moodle** from another. If the link expires first, `moodle mcp pair --json` in the same sandbox returns a new `setupUrl`.

No auth path needs choosing. Where the site enables Moodle's mobile app service, the Worker trades that first sign-in for a mobile token and renews itself from then on; elsewhere its tools answer with the sign-in link when the session expires. `deploy.json` says which one to expect under `renewalExpected` (`mobile_token`, `sign_in`, or `null` when the site could not be asked); tell the user before they sign in. `/readyz` reports which one applies under `renewal`.

The deploy skips the local session, renewal and client integrations.

The connector stays connected without a session. When Moodle is not signed in or the session has expired, tool calls return `MOODLE_AUTH_REQUIRED` with `recovery.url`; pass that link to the user and retry after they sign in. Only the owner's Moodle account is accepted. Each sign-in uses about two minutes of Cloudflare Browser Run time, which the free plan limits to ten minutes a day.

Never print or request the raw Moodle cookie, MCP access token, session sync token, or sesskey. An advanced operator may pipe a cookie directly to `moodle mcp session push --stdin`; do not place it in arguments or shell history.

### Let the Worker sign in through Okta

For a Moodle behind Okta, the Worker can sign in by itself when it holds the user's Okta username, password and TOTP secret as Worker secrets. Do this only when the user asks for it, and tell them first, plainly: their university identity then becomes only as safe as their Cloudflare account. Anyone who controls that account can read or replace the Worker and sign in as them, MFA included.

With the okta-auth CLI set up (`okta setup`), deploy with `--okta`; it runs `okta export` and adds the three secrets to the same private upload as the Worker's own credentials:

```bash
moodle mcp deploy --okta
```

To add them to an existing Worker by hand instead, pipe the export straight into Wrangler; never write it to a file or print it:

```bash
okta export --dangerously-print-password-and-totp-secret | npx wrangler secret bulk --name WORKER_NAME
```

Later deploys keep the secrets. Remove them with `npx wrangler secret delete OKTA_USERNAME --name WORKER_NAME`, and the same for `OKTA_PASSWORD` and `OKTA_TOTP_SECRET`.

The Worker signs in when the session is missing or expired, after the mobile token if it has one, and keeps Okta's device token and session, encrypted, between runs. It never retries a rejected password or one-time code, an MFA factor other than TOTP, or a sign-in to a different Moodle account; it stops until any of the three secrets changes. Network and Okta outages back off and stop after five failures in a row, until a session arrives some other way or a secret changes. `/readyz` then shows `renewal: "okta"` and an `okta:sign-in` check: `OKTA_READY`, or `OKTA_CREDENTIALS_REJECTED`, `OKTA_PASSCODE_REJECTED`, `OKTA_MFA_UNSUPPORTED`, `OKTA_INVALID_SECRET`, `OKTA_ACCOUNT_MISMATCH` or `OKTA_RETRIES_EXHAUSTED`.

### Managing private MCP access

After upgrading from the original OAuth release, run `moodle mcp pair` again because old grants are invalidated. Use `moodle mcp clients --json` to inspect OAuth clients, `moodle mcp revoke CLIENT_ID` to remove one client, or `moodle mcp revoke --all` to close all OAuth access, pending authorizations, and pairing windows. These use the owner's protected sync credential.

`moodle mcp deploy --rotate-token` invalidates previous static credentials and OAuth grants immediately. `moodle mcp deploy --rotate-key` re-encrypts and verifies the active session before retiring the previous encryption key. `moodle mcp deploy --repair` reconciles interrupted uploads using the live session revision. Rollback requires a compatible session schema and matching current keys/credentials; updates retain a static-bridge recovery release.

The Worker is pinned to its Moodle account. Do not reuse it for another account. Session records and local caches are encrypted; OS-protected credential storage is required. `--no-cache` bypasses reads and writes. Existing plaintext caches migrate when read, and managed removal deletes the matching authentication cache. Keep the owner's device and Cloudflare account trusted: the running Worker must decrypt the cookie to call Moodle.

## Runtime and removal

`moodle doctor` checks SQLite support, browser access, cached session liveness and local job pins.
Pinned commands prefer a standalone binary, then Bun, then a supported Node runtime.
Browser access denied on macOS: System Settings > Privacy & Security > Full Disk Access.
Allow the application running the command and restart it. Changing runtimes does not bypass this.

Wrangler is downloaded only for Cloudflare management and cached under
`~/.config/moodle-cli/tools/wrangler@VERSION`. A Wrangler already on PATH takes precedence.
The CLI, local MCP server and bridge do not require Wrangler.

`moodle uninstall --dry-run` shows local cleanup. `moodle uninstall` removes background jobs.
Add `--remote` to remove the configured Worker, and `--purge` to remove local configuration
and session cache after removing deployments. Use `--yes` for unattended cleanup.
Then remove the package with its package manager, or remove `~/.local/bin/moodle` for a binary install.
Other sites' Workers must be removed from their own configured profiles before purging receipts.

`moodle completion zsh`, `moodle completion bash` or `moodle completion fish` prints shell setup.
