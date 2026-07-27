# Sweet Cookie and OAuth in `moodle-cli`

Research date: 2026-07-27. Upstream checked at `steipete/sweet-cookie` commit [`c5dcb164`](https://github.com/steipete/sweet-cookie/tree/c5dcb164c8e76b861627b9d35952932b6a58d831); npm `latest` was `@steipete/sweet-cookie@0.4.0`.

## Conclusion

`@steipete/sweet-cookie` could substantially simplify and broaden `moodle-cli`'s **browser-session extraction**, but it does **not** perform OAuth or SSO login flows. Its OAuth-related feature is only multi-origin cookie lookup after a browser has already completed authentication. It does not open a browser, navigate an authorization endpoint, receive a callback, validate `state`, implement PKCE, exchange an authorization code, or manage access/refresh tokens. Upstream explicitly defines the library as “read cookies, not drive browser.” [Sources: [spec goals and non-goals](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/docs/spec.md#L3-L21), [public API](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/packages/core/src/types.ts#L52-L127), [OAuth 2.0 authorization-code flow](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1)]

For this project, that boundary is appropriate: Moodle's OAuth2 plugin completes its own handshake and then calls `complete_user_login`; Moodle creates a `MoodleSession...` cookie for the logged-in web session. The CLI can reuse that final Moodle cookie without possessing the IdP's OAuth tokens. [Sources: [Moodle OAuth2 login entry point](https://github.com/moodle/moodle/blob/fc1b95087ac93c9ae87f9ed67d810641eddc93dc/auth/oauth2/login.php#L35-L54), [OAuth2 login completion](https://github.com/moodle/moodle/blob/fc1b95087ac93c9ae87f9ed67d810641eddc93dc/auth/oauth2/classes/auth.php#L646-L657), [Moodle session cookie setup](https://github.com/moodle/moodle/blob/fc1b95087ac93c9ae87f9ed67d810641eddc93dc/lib/classes/session/manager.php#L317-L400)]

## Exact capabilities

- API: `getCookies(options)` returns `{ cookies, warnings }`; `toCookieHeader()` formats a request header. Sources can be inline JSON/base64/file or local browser profiles. Inline data wins and skips local reads. [Sources: [API and provider order](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/packages/core/src/public.ts#L19-L62), [types](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/packages/core/src/types.ts#L16-L50)]
- Cookie selection: primary URL, additional `origins`, exact-name allowlist, ordered browsers, `merge`/`first`, named/path/all-profile selectors, expired-cookie control, timeouts, and warnings that omit raw values. `origins` merely widens cookie lookup to SSO-related hosts. [Sources: [options](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/packages/core/src/types.ts#L52-L136), [multi-origin example](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/README.md#L77-L89)]
- Profiles: Chrome/Edge accept directory names, display names, paths, arrays, or `ALL_PROFILES`; Firefox has equivalent selection. This is stronger than the project's current hard-coded profile discovery. [Source: [profile behavior](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/README.md#L91-L130)]
- Escape hatch: the repository includes a user-triggered Chrome MV3 exporter for JSON/base64/file payloads. It requests permissions for entered origins and does no network transfer. The extension is private workspace code, not part of the npm package's published `files` list. [Sources: [extension behavior](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/README.md#L235-L245), [security constraints](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/docs/spec.md#L213-L219), [npm package contents](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/packages/core/package.json#L16-L23)]

## Browser and platform support

| Backend | macOS | Windows | Linux | Important detail |
| --- | --- | --- | --- | --- |
| Chrome/Chromium | Yes | Yes | Yes | Modern Chromium schema only (roughly 100+). macOS can pin Chrome, Brave, Arc, or Chromium. |
| Edge | Yes | Yes | Yes | Explicit backend; it is not in the default browser order. |
| Firefox | Yes | Yes | Yes | Uses built-in Node/Bun SQLite. |
| Safari | Yes | No | No | Reads `Cookies.binarycookies`; no profile selector. |

The default order is Chrome, Safari, Firefox. On macOS, the Chrome backend checks Chrome and Brave roots; on Windows/Linux, Brave and other Chromium-family browsers require an explicit profile/database path. Windows Chromium `v20` app-bound cookies may be skipped; upstream recommends its extension or CDP in that case. [Sources: [support matrix](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/README.md#L174-L186), [app-bound limitation](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/README.md#L222-L233)]

Runtime support is the main blocker: the published package requires Node 22 or Bun because it uses `node:sqlite`/`bun:sqlite`, while `moodle-cli` currently declares Node 20+ and tests Node 20. [Sources: [Sweet Cookie runtime](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/packages/core/package.json#L44-L46), [`moodle-cli` package](../../package.json), [`moodle-cli` CI](../../.github/workflows/ci.yml)]

## Concrete integration opportunities

1. **Replace the browser-provider internals, not the authentication model.** Keep `CookieProvider`, `matchingMoodleSessionCookies()`, validation, cache, and `okta-auth-cli` fallback. Adapt Sweet Cookie's output into `MoodleSessionCookie[]` inside `defaultBrowserCookieProvider()`.
2. **Gain Safari, Arc targeting, profile selection, and structured diagnostics.** Sweet Cookie can replace the optional `chrome-cookies-secure` path plus the custom Firefox `sqlite3` subprocess. Its built-in SQLite removes the system `sqlite3` requirement.
3. **Offer an explicit inline-cookie recovery path.** A future `--cookies-file` or config option could accept the extension export for app-bound encryption, keychain failures, or remote machines. Keep it opt-in, store files with restrictive permissions, and never log cookie values.
4. **Preserve current all-profile behavior deliberately.** Sweet Cookie defaults to one profile. Use `ALL_PROFILES` for Chrome/Edge/Firefox if broad discovery remains desired, or add an explicit profile option to reduce keychain prompts and accidental cross-account selection.
5. **Filter after extraction.** Sweet Cookie's `names` allowlist is exact, while Moodle permits a configured suffix (`MoodleSession{$CFG->sessioncookie}`). Calling with `names: ["MoodleSession"]` would miss suffixed cookies; extract host-matching cookies and retain the project's existing `startsWith("MoodleSession")` filter.

## Recommendation

Do not add Sweet Cookie solely to “support OAuth”: it cannot replace `okta-auth-cli` or implement generic OAuth. It is worth a small integration spike if the goal is reliable post-login session reuse across more browsers. Before adopting it, choose one compatibility policy:

- raise `moodle-cli`'s minimum Node version to 22; or
- load Sweet Cookie optionally on Node 22/Bun and retain the current provider on Node 20.

The second option preserves current compatibility but creates two extraction paths. Given the project's preference for low complexity, raising Node to 22 is the cleaner long-term route only if dropping Node 20 is acceptable.
