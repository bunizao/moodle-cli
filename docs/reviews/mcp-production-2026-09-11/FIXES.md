# MCP review fixes

The findings recorded against `79f6fe5` are addressed by `7e1b6bf` and `68727e8`. The original review is historical. The implementation remains one private Worker per Moodle account.

| Review item | Resolution | Evidence |
| --- | --- | --- |
| Cookie forwarded through redirects | Shared manual redirect handling across core AJAX/pages/downloads, browser validation and keepalive; bounded hops, timeouts, no credentials or form bodies forwarded to another origin | Unit controls and real workerd receiver sees no Cookie |
| Browser approval policies | Preserve a same-origin form Origin and permit only the validated callback origin in CSP | Unmodified Chromium approval reaches the callback; now required in CI |
| Anonymous registration exhaustion | Pending registrations expire/reclaim capacity; approved clients are retained; owner client management added | Flood followed by legitimate registration returns 201 |
| OAuth resource binding | Omitted resources bind to the canonical MCP resource; mismatches and old null-audience grants fail closed | Unit tests and live Cloudflare OAuth exchange without explicit resource |
| Full session confidentiality | Versioned encrypted remote payload includes Cookie, sesskey and identity; legacy records migrate when read | Durable Object proof contains only version and encrypted_session |
| Account changes | Validate and pin the Moodle user; reject a different or unknown account | Real Worker account-switch attempt returns conflict and original account remains active |
| Local persistence | Encrypt session cache with an OS-protected key; migrate readable legacy cache; protected credential migration; no silent macOS/Linux plaintext fallback | Cache/native-store tests; no-cache bypasses reads and writes |
| OAuth management | Clients list, individual/all revocation, pending-code/pairing invalidation, serialized broker state | Owner-only route and token-family controls |
| Rotation | Atomic secrets/code/marker deployment; old static credentials and OAuth grants invalidated; full payload re-encrypted before retiring the previous active key | Workerd and real Cloudflare rotation tests |
| Deployment migrations | Atomic wrangler deploy supports class lifecycle changes; latest deployment selected from ascending history; deploy output preserves the activated version identity | Adapter regressions and real v1-to-v2 migration |
| Recovery | Verify a schema/key/credential-compatible recovery release before the main update; preserve its identity; reject incompatible rollback; reconcile live revisions during repair | Manager regressions and live recovery/rollback checks |
| Secret-bearing errors and copies | Stable MCP errors, bounded request bodies, sanitized managed-registration backups, matching-cache cleanup, observability disabled by default | Unit/package/runtime checks |
| Toolchain advisories | Updated Wrangler/Vitest and transitive dependencies; bounded esbuild override; real runtime/browser regressions added to CI | npm audit: zero vulnerabilities |

## Validation

- 26 Vitest files: **302 passed, 1 Windows-only test skipped on macOS**.
- Typecheck, CLI/Worker/recovery builds, Worker import guard, package contents, packed install smoke and generated references passed.
- GitHub CI passed for Node 22, Node 24, Bun and Windows at implementation commit `68727e8`; Node 22 includes real workerd and Chromium consent tests plus dependency audit.
- Local workerd showed no cross-origin Cookie forwarding, no account retargeting, old static/OAuth access rejected after rotation, refresh replay rejected, one successful concurrent pairing, and registration capacity recovery.
- Real Cloudflare tests used isolated temporary Workers and synthetic accounts/credentials. They exercised fresh installation, v1 upgrade, migration to the encrypted record, default OAuth resource binding, removal of the previous active key, access/refresh revocation, recovery bridge operation and compatible rollback. Test resources were removed. The attached JSON records the individual checks.

Cloudflare deployment acknowledgement precedes edge propagation. The deployment verifier waits for the expected session schema, encryption-key identity and credential identity, rather than accepting a stale readiness response. Retiring a key requires proof that the current session has migrated. Rollback does not rewind Durable Object storage.

## Operating the repaired version

```sh
moodle --yes mcp deploy
moodle mcp pair
moodle mcp clients --json
moodle mcp revoke CLIENT_ID
moodle mcp revoke --all
moodle --yes mcp deploy --rotate-token
moodle --yes mcp deploy --rotate-key
moodle --yes mcp deploy --repair
```

The initial upgrade invalidates old OAuth grants; pair hosted clients again. Token rotation likewise requires native remote-header clients to receive their new credential; local bridges resolve the protected current token automatically. Recovery mode keeps the owner's static bridge available while OAuth is disabled until the main release is restored.

This work publishes the repaired branch and verifies isolated Cloudflare deployments. It does not merge the PR, publish a new npm version, or switch an existing personal production Worker. Actual Moodle/Claude account consent was not performed; tests used the real runtime/browser/provider with synthetic sessions. Cloudflare historical-version retention and device backup policies remain operator/platform controls, rather than claims of secure erasure by this code.

## Recorded acceptance results

- [Cloudflare v1 upgrade and recovery](cloud-upgrade-fixed.json)
- [Cloudflare fresh installation and recovery](cloud-fresh-fixed.json)
- [Actual workerd regression](runtime-fixed.json)
- [Actual Chromium consent](browser-fixed.json)
