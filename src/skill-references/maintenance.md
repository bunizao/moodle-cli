# Maintenance

Read this file for upgrades, agent-skill installation, or repository skill regeneration.

## Update the CLI

Check the npm registry without changing the installation:

```bash
npm view moodle-cli version
```

Upgrade an npm installation with `npm install -g moodle-cli@latest`. Standalone binaries are available from GitHub Releases.

If the registry check fails, verify network access and retry before proposing an upgrade command.

## Install the Agent Skill

Show skill metadata with:

```bash
moodle skills
```

Install from the published repository with:

```bash
moodle skills add
```

Extra arguments are passed to the shared `skills` CLI, for example `moodle skills add --agent codex`.

## Regenerate the Skill Bundle

Inside the `moodle-cli` source repository:

```bash
npm run build
npm run skill:generate
git diff -- SKILL.md references agents/openai.yaml
```

Regeneration is complete when the root skill, branch references, command reference, output contract, and agent metadata are all current.
