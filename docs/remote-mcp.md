# Remote MCP server

The [README](../README.md#remote-mcp) covers deploying. This page is the rest: every lifecycle command, connecting claude.ai, setting up without a browser, and operating the Worker.

## MCP lifecycle and protocol

```bash
moodle mcp deploy
moodle mcp status
moodle mcp login
moodle mcp connect
moodle mcp pair
moodle mcp remove
moodle mcp serve
moodle mcp bridge
```

The default client connection uses `moodle mcp bridge`, which keeps the Bearer token out of client configuration. Use `moodle mcp connect CLIENT --mode remote` for clients that support authenticated remote MCP headers.

## Connect claude.ai

claude.ai custom connectors authenticate with OAuth, so the deployed Worker is also a single-user OAuth 2.1 authorization server. Nothing is approved until you open a pairing window from your own computer:

```bash
moodle mcp pair
```

The command prints the connector URL and a one-time pairing code that is valid for ten minutes and one approval. Add the URL as a custom connector in Claude, sign in when Claude opens the approval page, and enter the code. Claude then keeps a rotating OAuth token instead of your Bearer token, and `/authorize` refuses every request while no pairing window is open.

The approval page also offers **Sign in with Moodle**. It opens Moodle in a remote browser in your own Cloudflare account (Browser Run); signing in there as the Worker's Moodle account approves the connector without a pairing code and renews the Worker's session at the same time. Any other Moodle account is refused.

## Set up without a local browser

From a cloud sandbox or any machine without a signed-in desktop browser:

```bash
moodle mcp deploy --remote-login --yes
```

Without a terminal, Cloudflare sign-in uses the OAuth device grant: the command prints a `dash.cloudflare.com` link, you approve it in any browser, and no API token is needed (`CLOUDFLARE_API_TOKEN` still works when set). It then deploys the Worker without a Moodle session and prints a sign-in link valid for ten minutes. Open it, sign in to Moodle in the remote browser, and the Worker is claimed for that account. Then add the printed endpoint as a custom connector: in the same browser the approval page already knows you, and elsewhere **Sign in with Moodle** does the same. If the link expires first, run `moodle mcp pair` on the same machine for a new one.

Until Moodle is signed in, and whenever the session expires, the connector stays connected and its tools answer with the sign-in link instead of data. Each sign-in uses about two minutes of Browser Run time; the Cloudflare free plan allows ten minutes a day.

Where the Moodle site enables its mobile app service, the Worker needs one sign-in only: whenever it receives a session, from the CLI or from a remote sign-in, it also asks Moodle for a mobile app token, keeps it encrypted next to the session, and uses it to open a fresh session whenever the old one expires. `moodle mcp status` and `/readyz` show which path the Worker is on (`renewal: mobile_token` or `sign_in`). Sites with the mobile service off, and site administrators, stay on the sign-in link. You can revoke the token at any time under **Preferences → Security keys** in Moodle.

Version `0.7.0` supports MCP `2026-07-28`, a stateless compatibility lane for `2025-11-25`, and the `2025-06-18` and `2025-03-26` revisions that current hosted clients negotiate.

## Private MCP operations

Each Worker is pinned to one Moodle account. Uploads for a different account are rejected; use a separate deployment for that account. Session cookies, sesskeys and account metadata are encrypted together. Existing remote records and local caches migrate when read. Local cache encryption keys and deployment credentials require OS-protected storage (Windows also supports DPAPI); macOS/Linux no longer silently create plaintext credential files. `--no-cache` bypasses cache reads and writes.

```bash
moodle mcp clients --json
moodle mcp revoke CLIENT_ID
moodle mcp revoke --all
moodle --yes mcp deploy --rotate-token
moodle --yes mcp deploy --rotate-key
moodle --yes mcp deploy --repair
```

The initial upgrade invalidates old OAuth grants; run `moodle mcp pair` again for hosted clients. Revocation closes pending authorizations and pairing windows as well as tokens. Token rotation immediately invalidates old static credentials and OAuth grants; local bridge configurations resolve the new token automatically. Native remote header clients must receive the new token. Key rotation migrates the active encrypted record, verifies it, then removes the previous key from the active configuration.

Deployment uses Cloudflare's atomic code/secrets operation, including Durable Object migrations. An update first verifies a compatible recovery release that supports the owner's static bridge; OAuth is temporarily unavailable in recovery mode. Rollback checks session schema, encryption-key identity and credential identity. It will not activate an incompatible pre-migration version or restore revoked credentials. `--repair` reconciles the live session revision after interrupted uploads.

Pending OAuth registrations expire after ten minutes and can be reclaimed without evicting approved clients. The approved client limit is 20. Credential-bearing requests have bounded redirects and timeouts; foreign redirect destinations never receive the Moodle cookie. Worker request bodies are limited to 64 KiB. Managed deployment disables request observability by default to avoid retaining authentication form bodies or query data in logs.
