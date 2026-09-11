# MCP security and production readiness review

**Decision: NO-GO for production at `79f6fe5`.** The cookie encryption primitive works, but an upstream redirect can disclose the decrypted cookie. The browser OAuth flow and the upgrade from existing deployments also have confirmed blockers.

Reviewed on 2026-09-11: [PR #25](https://github.com/bunizao/moodle-cli/pull/25), `feat/mcp-cloudflare-worker`, head `79f6fe5a3a85c7ed3765e0895afb43b000e38948`, base `f35adba8b2edfd6c599c7bbe27866cb1881d4217`. The remote PR was still open, mergeable, and green in CI. Those facts do not establish successful deployment.

The owner explicitly selected **one independently deployed private Worker per person**. The single-owner architecture fits that requirement. This review does not demand a shared multi-tenant platform. It covers all 24 changed files, including 13 source files, and supporting session, credential, network, and deployment paths. No application source was changed, no production service was mutated, and probes used synthetic sessions only.

## Blocking findings

| Priority | Finding | Evidence | Change status |
| --- | --- | --- | --- |
| P1 / high security | Cross-origin activity redirects forward `MoodleSession` | Original Worker in workerd sent the synthetic cookie to a different-origin HTTP receiver | Existing helper, also reachable through new OAuth |
| P1 / functionality | Browser approval is blocked by response policies | Chrome 152: shipped page causes `Origin: null` and HTTP 403; fixing only referrer policy exposes a CSP callback block | Introduced by OAuth |
| P1 / deployment | Existing v1 Worker cannot apply the AuthBroker migration through `versions upload` | Exact adapter call sequence conflicts with Cloudflare's documented lifecycle restriction | Introduced by new v2 migration |
| P2 / medium security | Anonymous registrations permanently exhaust all 20 client slots | 20 anonymous HTTP 201 responses, then legitimate registration gets HTTP 400 | Introduced by OAuth; cap preserves existing clients |

### 1. Prevent Cookie forwarding on every redirect hop

`src/moodle-client-core.ts:633-639` checks the initial origin, attaches the Moodle cookie, and calls `fetch` with `redirect: "follow"`. That protects a direct foreign request, but workerd forwards the attached Cookie through subsequent redirects.

The real Worker probe completed OAuth authorization, loaded a synthetic Moodle URL activity through `get_activity`, received an upstream redirect, and observed the exact synthetic cookie at the external receiver. The result is recorded as `crossOriginRedirect.syntheticCookieForwarded: true` in [runtime-evidence.json](runtime-evidence.json). Normal MCP JSON did not contain the cookie or sesskey; the vulnerable path is the outbound redirect.

An attacker must control an activity destination or an upstream redirect reached by an authorized client. The leaked cookie may permit upstream account impersonation beyond the read-only MCP API. A real Moodle account replay was deliberately not attempted. This is high severity, not a claim of automatic compromise of every installation.

Fix the existing request helper: follow a bounded number of redirects manually, validate each destination, and attach credentials only to the configured Moodle origin. Strip Cookie and other sensitive headers across origins. Verify same-origin redirects still work, foreign receivers see no credential, and loops/downgrades terminate safely. Storage encryption alone cannot fix this.

### 2. Make the actual browser consent flow succeed

`src/worker/oauth.ts:600-610` sends both `Referrer-Policy: no-referrer` and CSP `form-action 'self'`. In Google Chrome **152.0.7977.84**, the actual local HTTPS approval page behaves as follows:

| Test | Result |
| --- | --- |
| Unmodified response | Form POST has `Origin: null`; `src/worker/http.ts:230-244` rejects it with `403 INVALID_ORIGIN`; no callback |
| Change only Referrer-Policy in the test response | Correct Origin reaches the request, but Chromium blocks the cross-origin authorization redirect under `form-action 'self'`; no callback |
| Change referrer policy and permit the exact validated callback origin in the test response | Application returns 302 and browser reaches the callback with a code |

[browser-evidence.json](browser-evidence.json) preserves all three runs. The latter two are instrumented controls, not shipped fixes. The callback was an allowed local loopback server; no Claude account was contacted. Ignoring the local synthetic TLS certificate was the browser transport accommodation.

Preserve Origin on the consent POST and arrange a browser handoff compatible with the validated callback. If CSP is adjusted, allow only the validated destination rather than arbitrary origins. Keep redirect validation, PKCE, owner pairing and origin protection intact. Add a real-browser consent regression; HTTP-only OAuth tests miss both failures.

### 3. Handle the v1-to-v2 lifecycle migration explicitly

`src/mcp/deployment/node-adapters.ts:334-336` adds `AuthBroker` through migration v2. Only a new installation invokes `initializeWorker` / `wrangler deploy` (`managed-deployment.ts:315-322`). An existing installation uploads secrets and then calls `wrangler versions upload` (`node-adapters.ts:221-232`). Secret bulk cannot apply a class migration.

Cloudflare's [deployment management documentation](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#durable-object-migrations) states:

> Uploading a version that changes Durable Object class lifecycle is not supported.

The same section requires class creation, deletion, rename or transfer to use `wrangler deploy`. Therefore an existing v1 installation cannot reconcile the new class through the current path. Fresh installations and already-migrated Workers are different cases. This conclusion is based on official platform documentation and source, not a claimed live failed deployment.

Two associated constraints must shape the repair:

- [Preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/#limitations) are not generated for Workers implementing Durable Objects. This bundle exports both classes. The existing no-preview path promotes the version at `managed-deployment.ts:347-353`, before session upload and smoke checks. Do not claim pre-production preview validation or isolated preview state.
- [Lifecycle changes prohibit rollback to earlier versions](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/#durable-object-class-lifecycle-changes). After applying v2 correctly, recovery must retain the introduced class; it cannot simply activate the pre-v2 bundle. [Code rollback also does not rewind bound data](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings).

Implement a migration-aware deployment/recovery path with a compatible fallback bundle, then exercise both fresh install and upgrade from a real v1 staging Worker. A successful `versions upload` on an already-v2 Worker is not sufficient evidence.

### 4. Prevent permanent anonymous client-slot exhaustion

Public `/oauth/register` accepts allowlisted callback metadata without pairing or owner authentication. Each request creates a permanent row. `src/worker/oauth.ts:290-302` rejects registrations at 20, and neither pruning nor revocation deletes client rows.

An anonymous caller can submit the same permitted callback 20 times. The runtime probe then gets `400 invalid_client_metadata` for the legitimate next registration. Owning the callback host is not required to submit its string. Existing clients continue working, so this is persistent onboarding/reconnection denial of service, not loss of existing-client access.

Retain approved clients while expiring unapproved registrations, and add owner-authenticated cleanup. An owner-opened registration window is another option if compatible with the hosted client's registration order. Rate limiting alone cannot reclaim permanent fake registrations. Do not restore the former behavior of evicting already-authorized clients.

## What is encrypted, and what is not

| Asset or phase | Current protection | Assessment |
| --- | --- | --- |
| Remote Moodle cookie | AES-GCM, random 12-byte IV, key derived from a random 32-byte generated secret, key supplied as Worker Secret | Primitive and negative tests pass; outbound redirect leak still defeats end-to-end secrecy |
| Remote sesskey, Moodle user ID and lifecycle metadata | Outside the application's AES-GCM envelope | Do not describe the full session record as application-encrypted; provider storage encryption is a separate layer |
| Worker execution | Cookie is decrypted inside SessionBroker and used for Moodle calls | Worker/operator authority remains trusted; this is not end-to-end or zero-knowledge encryption |
| OAuth access/refresh/code/pairing secrets | Digests persisted; raw opaque tokens returned to their intended client | Positive control confirmed; normal tool responses contained no raw cookie/sesskey |
| Local Moodle session cache | Plaintext JSON at `~/.cache/moodle-cli/session.json`, mode 0600 | `--no-cache` intentionally bypasses reads only; it is not a no-persistence option |
| Deployment credentials | Native OS vault preferred; macOS/Linux fallback is plaintext JSON under a 0700 directory, mode 0600; Windows fallback uses DPAPI | Permission protection is not application encryption of every local copy |
| Temporary deployment secrets | Raw encryption key in a 0600 temporary file inside a 0700 directory; cleanup in finalizer | Review crash leftovers, backup/encryption policy and cleanup during operational acceptance |
| Client configuration | Bridge stores command/profile only; explicit native remote mode stores a bearer and can retain config backups | Prefer bridge for local clients; OAuth clients retain their own tokens |

The [crypto probe](crypto-evidence.json) passed round-trip, randomized IV, plaintext absence from ciphertext, tampering rejection, wrong/missing key rejection, previous-key decryption, and rotation detection. No cryptographic primitive failure was found.

`--rotate-token` changes static access/sync credentials, **not** the session encryption key. Runtime supports one previous encryption key, but managed materialization does not implement a complete key-rotation workflow. For a requirement that all stored session secrets be encrypted, include sesskey in a versioned encrypted payload and address local cache/fallback copies as well. Protecting an entire session object is a product guarantee decision, not a reason to invent a remote exploit from plaintext metadata alone.

## Authorization and recovery limits

The runtime probe verified two behaviors that need explicit operational safeguards:

- Replacing the sole session from synthetic user 101 to 202 leaves the existing OAuth grant valid, and it reads user 202. No subject or account-generation binding is checked. Prevent accidental account changes or require explicit confirmation and reauthorization when the Moodle identity changes.
- Changing static access/sync digests makes the old static bearer return 401, while the old OAuth bearer still returns 200 and its refresh grant remains usable. Routine static rotation is not global logout. Provide owner-authenticated grant listing/revocation and revoke-all, including an incident drill for a sync credential used to mint an unwanted OAuth grant.

These are source-confirmed lifecycle behaviors, **not independently proven cross-tenant vulnerabilities** in the selected single-owner model. Session replacement already requires owner sync authority, and static/OAuth credentials are distinct mechanisms. Preserve that distinction when communicating risk.

The PR's resource-binding claim is also incomplete: omitting `resource` can persist null (`oauth.ts:159`, `:414`), and verification skips comparison for null (`:536`). Default to the canonical deployment `/mcp` or require the resource. No cross-deployment token-lookup exploit was established because each Worker has private AuthBroker state and one protected resource.

## Verification and evidence limits

| Check | Outcome |
| --- | --- |
| Existing Vitest suite | 25 files; 286 passed, 1 Windows-specific test skipped on macOS |
| TypeScript check, CLI build, Worker build and bundle guard | Passed |
| Package contents and packed install smoke | Passed |
| Generated skill/reference drift | Passed |
| Existing remote PR CI | Node 22, Node 24, Bun and Windows checks green at reviewed SHA |
| Actual workerd HTTP flow | Pair/authorize/token/MCP succeeded; targeted vulnerabilities and lifecycle behaviors reproduced |
| Refresh replay | Reused refresh token returns 400 and descendant access returns 401 |
| Concurrent pairing | One 302 and one 403; no demonstrated production race |
| Actual Chromium consent | Failed on shipped response headers; positive control isolated the causes |
| Real Cloudflare fresh install / v1 upgrade / failure recovery | Not performed; known blockers must be repaired first |
| Real Moodle/Claude account, sustained upstream performance, log retention and data-deletion guarantees | Not verified |

Installed versions: Wrangler 4.120.0, Miniflare 5.20260801.1-alpha, workerd 1.20260801.1, Vitest 3.2.7. Local Worker probes selected compatibility date `2026-08-08`; production's exact runtime/date remains an acceptance check. Node for this local run was 26.5.0; remote CI supplies separate Node 22/24 evidence.

`npm audit` reported **8 affected package entries: 5 high, 2 moderate, 1 low**. Production-dependency audit reported 3 high entries in the `wrangler -> miniflare -> sharp` chain. Package manifests and lockfile are unchanged from the base branch. These are primarily local test/build/deployment surfaces and are not proof of eight remotely exploitable Worker vulnerabilities. Update supported toolchain dependencies, rerun checks, and record reachability/disposition for any remaining advisory before declaring the distributed CLI production-ready.

No provider logs or user credentials were inspected. Synthetic output checks and generic error wrappers establish only their tested paths; they do not certify that every upstream exception, provider log, backup or client transcript is secret-free. Readiness does not replace real upstream latency, session-expiry, revocation and recovery drills.

## Standards

Independent standards review found **0 documented hard violations and 0 actionable smell findings** across all 24 changed files. Comments are English, commit subjects use Conventional Commits, and no dependency or unnecessary framework layer was added. The checked-in AGENTS.md describes an obsolete Python architecture; current package/source defines TypeScript and Vitest. This standards result does not establish security readiness.

## Spec

The private single-owner architecture matches the selected requirement. OAuth intentionally extends the old plan; it is not scope creep. The independent initial spec pass identified two gaps: optional resource binding and incomplete production acceptance. Subsequent browser tests and official Cloudflare research make the browser-consent and v1-upgrade failures concrete parts of that acceptance gap.

## Required release acceptance

1. Repair and regress the four blocking findings, including real-browser OAuth and workerd cross-origin Cookie handling.
2. Resolve session confidentiality wording and implementation: cookie-only versus full record, local cache/fallback protection, key rotation and cleanup. Do not claim every copy is encrypted while retaining plaintext caches.
3. Add explicit account-change handling and owner OAuth revocation/revoke-all; verify old access and refresh credentials stop working after the chosen recovery action.
4. Validate canonical resource binding, registration recovery, expired sessions, unavailable Moodle, key-loss recovery, bounded requests and secret-free error paths.
5. Reconcile dependency advisories and run the package/release matrix on supported runtimes.
6. In a separate staging deployment, prove fresh install and v1-to-v2 upgrade, browser/hosted-client OAuth, token and encryption-key rotation, and recovery compatible with the class migration. Observe the actual active version, bindings and health afterward.
7. Record provider log/backup/deletion controls and realistic upstream timeout/performance behavior. A green build or uploaded Worker is insufficient evidence of active production readiness.

The appropriate release decision remains **NO-GO until repairs and these acceptance checks are completed**. This commit contains review artifacts only.

## Reproducing the local probes

From the repository root, install the lockfile dependencies and build once. The probes run only local synthetic servers and close them afterward:

```sh
npm ci
npm run build
node docs/reviews/mcp-production-2026-09-11/runtime-probe.mjs
node docs/reviews/mcp-production-2026-09-11/browser-probe.mjs
```

The browser probe additionally needs Playwright and installed Google Chrome. If Playwright lives in another runtime, set `MOODLE_REVIEW_PLAYWRIGHT_PACKAGE` to that runtime's absolute package.json path. `POLICY_MODE=baseline` is the default; `referrer-only` and `fixed` change response headers solely to isolate the browser failure. They do not edit source or constitute a production fix. Set `MOODLE_REVIEW_ROOT`, `MOODLE_REVIEW_OUTPUT` (HTTP probe), or `MOODLE_REVIEW_OUTPUT_DIRECTORY` (browser probe) when needed. Rebuild after changing source; observed JSON records the checkout revision.

The HTTP probe records current behavior rather than asserting that an unsafe behavior is desirable. Its synthetic account-change and static-rotation checks are not production mutations.

## Scan record

Security scan `729d1109-10fa-4804-92ec-f6a62e5888b7` completed with two confirmed vulnerabilities (one high, one medium). All changed source was reviewed; coverage is explicitly partial for full production acceptance because live/provider operational checks remain outstanding. Six security candidates were dispositioned; account retargeting, independent static-token rotation, optional resource binding and a conjectured pairing race were not promoted to unsupported exploits.

The scan tool reported aggregate usage across five task contexts: 18,471,608 total tokens, including 17,780,089 cached input tokens and 70,135 output tokens. This is the tool's cumulative accounting, not a billable-cost estimate.
