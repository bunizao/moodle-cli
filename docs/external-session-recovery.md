# Optional external session recovery

The private MCP Worker normally keeps a browser session alive with Moodle's HTTP session services. After hard expiry it first mints a fresh session from a kept Moodle mobile token. Sites that turn the mobile service off have no such token, so deployments with a separate authentication service can opt into server-side recovery as the next step. The authentication service may use any SSO provider, a mobile credential, or another owner-controlled login mechanism. Moodle CLI does not manage that service's passwords, MFA secrets, or browser automation.

This is an advanced option: you write and deploy the recovery Worker yourself, on the same Cloudflare account. Moodle CLI only binds to it.

## Bind the recovery Worker

Name it on deploy:

```bash
moodle mcp deploy --session-recovery-service your-session-recovery-worker
```

That adds an HTTP Service binding to the generated Wrangler configuration:

```jsonc
{
  "services": [
    { "binding": "MOODLE_SESSION_RECOVERY", "service": "your-session-recovery-worker" }
  ]
}
```

The deployment receipt records the name, so later deploys and CLI upgrades keep the binding without the flag. `--no-session-recovery-service` removes it. `moodle mcp deploy --dry-run` shows which Worker is bound.

Upload and validate the initial Moodle session through the existing `/session` flow first. That pins the deployment to a Moodle account. The recovery binding cannot bootstrap an empty deployment or change its owner. A shared authentication service must map the requested origin and user ID to an owner-authorized identity; it must not treat the request as authorization to sign in as an arbitrary account.

## Service contract

The broker calls `MOODLE_SESSION_RECOVERY.fetch()` with `POST https://session-recovery/recover`, `Content-Type: application/json`, and this body:

```json
{
  "moodleOrigin": "https://lms.example.edu",
  "moodleUserId": 42,
  "reason": "SESSION_EXPIRED"
}
```

The hostname is a routing placeholder for the private Service binding, not a public network destination. No current Moodle cookie, password, MFA secret, OAuth token, or encryption key is sent. The service should expose this operation only to authorized callers, for example through a private Worker with no public route.

Return HTTP `200` with `Content-Type: application/json` and a candidate session:

```json
{
  "moodleOrigin": "https://lms.example.edu",
  "cookieName": "MoodleSession",
  "cookieValue": "<new application session>"
}
```

Return HTTP `204` when no candidate is available. Other failures, redirects, malformed candidates, or bodies larger than 16 KiB are rejected. The provider returns a candidate; it must not write the Moodle Worker's storage directly. Its operation should support cancellation and enforce its own limits on expensive recovery work.

For custom code and tests, `SessionRecoveryProvider.recover()` provides the same contract plus an `AbortSignal`, and returns `RecoveredSession | null`. It can be injected through `SessionBrokerDependencies.recovery`.

## Recovery lifecycle

1. Normal alarms and explicit session touches keep using Moodle HTTP renewal. An estimated expiry is checked with HTTP before recovery. Unreachable Moodle services and malformed HTTP responses do not trigger login recovery.
2. An explicitly rejected session renews in order: mint from the kept mobile token, then the configured provider, then the sign-in hint for the owner. The provider is not called when the mint succeeds. An MCP read can retry once after renewal; the remote MCP tool set remains read-only.
3. The broker validates the candidate against the configured Moodle origin, obtains its account ID and `sesskey`, and requires the original account ID. It encrypts the accepted session using the existing storage path.
4. A compare-and-swap revision check prevents a delayed recovery from overwriting a newer uploaded session. Existing MCP OAuth grants remain valid for that same account.
5. Concurrent requests in the session-owning Durable Object share one attempt. A five-minute retry budget is persisted before external I/O, so failed calls or object reconstruction cannot immediately relaunch recovery. The broker's renewal alarm retries on its usual slow schedule; readiness checks only report state.
6. The provider has a 60-second wait limit, and candidate validation is bounded by the Worker's own Moodle request timeout. The provider's signal is aborted on timeout, and late results are discarded. This does not guarantee that an external service stops its own browser job: the service must enforce cancellation and concurrency guards itself.

Provider failures leave the existing session and pinned owner in place and return the usual session-expired failure. Raw provider diagnostics are not returned to MCP clients. No provider is configured by default; the existing manual upload and local renewal paths continue to work.
