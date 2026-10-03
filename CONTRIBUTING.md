# Contributing to moodle-cli

Thanks for helping. Bug reports from real Moodle sites are the most valuable contribution, because every site is configured differently and no test suite covers them all.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Report a bug

1. Run `moodle update`. Your problem may already be fixed.
2. Run `moodle coverage --json` and attach the output. It shows the CLI version, the Moodle release and theme, the services your site disables, and which commands pass. It holds counts, ids and error messages, not your name or unit titles.
3. Describe what you ran, what you expected, and what happened instead.

Never paste your `MoodleSession` cookie, a `sesskey`, an MCP access token or a Cloudflare token. If you attach HTML saved from your Moodle, remove names, student ids and anything else personal first.

## Propose a change

For anything bigger than a small fix, open an issue first so we can agree on the shape before you write the code.

Then:

1. Fork the repo and branch from `main`.
2. Set up and run the checks as described in the [development guide](docs/development.md).
3. Open a pull request against `main`. CI runs on pull requests from forks once a maintainer approves the run.

A pull request is ready when:

- `npm run check`, `npm test` and `npm run build` pass.
- New behaviour has a test. A fix to a page reader adds a fixture under `tests/fixtures/`, saved from a real page with personal data removed.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), such as `fix(grades): keep the course total on an empty gradebook`.
- If you changed a command or an option, the skill bundle is regenerated: `npm run build && npm run skill:generate`. CI fails when `SKILL.md`, `references/` or `agents/openai.yaml` drift.
- It does one thing. Two unrelated fixes are two pull requests.

## Project rules

These come from things that went wrong before. A pull request that breaks one will be asked to change.

- **Never log or print a credential.** That covers the Moodle session cookie, `sesskey`, mobile tokens, MCP access tokens and Cloudflare tokens, including in errors and debug output.
- **No institution-specific code.** Do not hardcode a university's name, domain or unit codes, and do not match unit codes by pattern. Tests and docs use placeholders such as `UNIT1001` and `moodle.example.edu`. `npm run build` rejects shipped files that name an institution.
- **One sign-in path for every site.** Authentication borrows the browser session, with renewal through the Moodle mobile service where the site enables it. Do not add a login flow for one site or one identity provider.
- **Read the site's own wording.** Page readers look up labels with `core_get_strings` instead of matching English text, so they work on translated and customised sites.
- **No new dependencies without a concrete reason.** The CLI ships as one npm package and a standalone binary, and the Worker bundle must stay self-contained.
- **Small and explicit beats clever.** Prefer the smallest change that solves the problem and reads clearly in a year.

## License of contributions

moodle-cli is released under the [MIT License](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms.
