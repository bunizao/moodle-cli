# Reference

Details behind the [README](../README.md): checking a site, updating, what an install leaves behind, and the output envelopes.

## Check your site

```bash
moodle coverage
```

Moodle sites differ: some disable web services, and themes, languages and course formats change the pages the CLI reads. The page readers ask the site for its own wording of the labels they look for, so a site in another language or one that renamed a label is read the same way. `moodle coverage` signs in with your session and runs each read-only command once against your own units, printing one line per command as it finishes. Nothing is created and submitting is never exercised, but Moodle logs the pages it opens as views, as it does when you browse them, and can mark forum posts read.

A command passes only when its answer agrees with what the site states elsewhere in structured form: an activity's name and files against the unit's contents, an assignment's due date against the calendar, a forum search against a discussion the forum is known to hold. Each passing line says what it was checked against. The other outcomes are: worked through a fallback, read but not understood (`?`), contradicts the site (`≠`), failed, or skipped for lack of a sample. Only activities you can open are sampled, a transient network error is retried once, and a check that hangs times out. Stock Moodle never lets the AJAX endpoint call some of the services the CLI tries first, such as the course contents; going around those is the normal path and is not reported as a fallback. It exits with code 3 when a command fails, contradicts the site, or reads a page it does not understand.

The first line names the moodle-cli release and whether it is the latest, checked live; a failure from an old release may already be fixed, so run `moodle update` before reporting one. `moodle coverage --json > coverage.json` gives the same report as JSON, with the CLI version and runtime, the Moodle release, theme and the services the site disables. It holds counts, ids and error messages, not your name or the titles of your units, so it can be attached to an issue when your school's Moodle misbehaves.

## Update

```bash
moodle update
```

`moodle update` upgrades the package with whichever installer put it there (npm, bun, or the standalone binary replacing itself), then runs `moodle mcp deploy` when a managed Worker exists and is behind the new release. `moodle update --check` only reports versions.

It installs the exact release it just checked rather than `latest`, so a lagging registry mirror fails loudly instead of installing an older build, and an npm install goes into the prefix that holds the running copy, whichever `npm` is first on `PATH`. A standalone download has to run and report the new version before it replaces the current binary; otherwise the old one stays. After installing, the update asks the replaced install for its version and only then redeploys the Worker.

The CLI checks npm once a day in the background and prints a one-line notice on stderr when a newer release exists. A deployed Worker performs the same daily check and tells connected MCP clients through the server instructions, because the Worker ships inside the package and only redeploys from your machine. Set `MOODLE_NO_UPDATE_CHECK=1` to disable the check; it is already off under `CI`.

## Installation footprint and removal

| Install path | Files left locally |
| --- | --- |
| Installer | `~/.local/bin/moodle`; configuration and cache after first use |
| Manual binary | The chosen executable; configuration and cache after first use |
| npm global | npm global package/bin; configuration and cache after first use |
| Bun global | Bun global package/bin; configuration and cache after first use |
| npx | npm execution cache; configuration and cache after first use |
| bunx | Bun execution cache; configuration and cache after first use |

The CLI, local MCP server and bridge do not install Wrangler. Cloudflare management
uses Wrangler on PATH, or downloads the pinned version into
`~/.config/moodle-cli/tools/wrangler@VERSION`. A binary install needs Bun or Node/npm
only when managing Cloudflare. Worker payloads are included in the binary.
Background jobs are opt-in: keepalive and managed MCP renewal.

`moodle uninstall --dry-run` previews cleanup. `moodle uninstall` removes local jobs;
`--remote` also removes the selected Worker; `--purge` removes local configuration/cache
after deployments have been removed. Finish with `npm rm -g moodle-cli`,
`bun remove -g moodle-cli`, or removal of the standalone executable. Package-manager
execution caches are managed by npm/Bun themselves.

## Structured output (since 0.8)

CLI JSON and MCP use compact envelopes: `units`, `unit` plus `sections`, `due`, `item`,
`grades`, `news`, `thread`, `results`, or `file`. Empty strings and lists are omitted;
`total: 0` identifies an empty result. List rows use `type`, `unit_id`, `section_id`
and `name`. Dates include ISO offsets and epoch seconds. Unit detail defaults to a
section index; pass a section for activities. `--fields` selects envelope keys.

The 11 default MCP tools are home, due, units, unit, find, item, grades, news, thread,
search_forums and file; a local server adds submit, whose `submission` envelope is the
upload receipt. Old names remain callable through 0.8 with the new envelopes;
they are deprecated and omitted from default discovery to avoid duplicate catalog cost.
The local command tree remains available, including courses as an alias for units.
The unused projects/quiet aliases were removed. `--verbose` (`-v`) prints sanitized
request paths and timing; it never logs URL queries or credentials.

Run `npm run measure:mcp` to reproduce fixture payload measurements. See
[implementation evidence](plans/optimization-implementation.md) for live checks,
measurement scope and remaining budget differences.
