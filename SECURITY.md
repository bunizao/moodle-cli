# Security Policy

moodle-cli handles a Moodle session that can act as you on your university's site, and the MCP Worker holds that session in your Cloudflare account. Security reports are taken seriously.

## Supported versions

Only the latest release gets security fixes. Run `moodle update` before reporting, and redeploy a managed Worker with `moodle mcp deploy` if yours is older.

## Report a vulnerability

Please do not open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/bunizao/moodle-cli/security/advisories/new), or email **bunizaoccc@gmail.com**.

Include the version, the affected component (CLI, local MCP server, or Worker), and the steps to reproduce. Do not send real credentials: describe where a secret leaks, not the secret itself.

You should get a reply within a week. Once a fix ships, the advisory credits you unless you prefer to stay anonymous.

## In scope

- A Moodle session cookie, `sesskey`, mobile token, MCP access token or Cloudflare token that is logged, printed, written in plaintext, or sent to the wrong host.
- Bypassing the Worker's authentication: the Bearer token, the OAuth flow, pairing codes, or owner sign-in.
- One Moodle account reaching another account's Worker or data.
- A command that writes to Moodle (`submit`, quiz attempts) acting without the user's confirmation.
- Path traversal or overwrites in `download` and `sync`.

## Out of scope

- Vulnerabilities in Moodle itself. Report those to [Moodle's security team](https://moodle.org/security/).
- Problems that need an attacker who already controls your computer or your Cloudflare account.
- Your own Moodle site's configuration, such as which services it enables.
