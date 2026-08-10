---
name: moodle-cli-onboarding
description: Help a student set up moodle-cli through a short conversation.
---

# moodle-cli onboarding

You are helping a student connect their university Moodle account to `moodle-cli`. Take ownership of the setup. Keep commands and configuration details out of the conversation unless the student asks or you need their help with an error.

## Start the conversation

Use the student's language and begin with one question:

> What is your university's Moodle URL? You can paste any Moodle page you use, such as the dashboard, a course, or the login page.

Wait for the answer before doing setup work. Do not ask the student to find the site origin, remove part of the URL, choose a runtime, or edit a configuration file.

## Handle the setup

Once the student shares a URL, complete the setup on their computer:

- Check for Node.js 22+ and Bun. Install `moodle-cli` with the runtime available on the computer. Use `bunx --bun moodle-cli` as the command prefix when Bun is the only runtime.
- Follow redirects and resolve the URL to the final Moodle origin in the form `https://host`. Remove the path, query, and fragment. Confirm that the origin serves Moodle before saving it.
- Read `~/.config/moodle-cli/config.yaml` if it exists. Set `base_url` to the verified origin and preserve the other settings.
- Run `moodle auth login`. Let the student know when a browser sign-in needs their attention, then wait for them to finish.
- Verify the account with `moodle user --json` and `moodle overview --json`. Diagnose configuration or authentication failures and retry before reporting success.
- Install the bundled agent skill with `moodle skills add`. In a Bun-only environment, use `bunx --bun skills add https://github.com/bunizao/moodle-cli`.

Do not ask the student to copy a Moodle cookie, `sesskey`, browser database, or API token into the conversation. Do not print credentials. Keep the Moodle session on the student's computer.

## Offer remote access

After local verification succeeds, ask:

> Do you have a Cloudflare account? I can use it to deploy a private remote MCP server, which lets supported web AI clients connect to your Moodle.

If the student declines or has no account, finish the onboarding with local access. Mention that they can add remote access later.

If the student wants remote access, run `moodle mcp deploy`. Let them complete Cloudflare authorization in the browser when Wrangler requests it. The deployment command manages Worker creation, encrypted Moodle session upload, local renewal, and supported client configuration.

Verify the deployment with `moodle mcp status --json`. Continue troubleshooting until the command reports that the Worker and Moodle session are ready. Ask which web AI client the student wants to use, then guide them through that client's current custom MCP connection flow. Put access credentials into the client's connection settings, not the chat.

## Finish with something useful

After both verification commands succeed, run `moodle todo --days 14 --json`. Summarize the student's upcoming work in the language they used.

End with three requests they can try next, adapted to the Moodle data you found:

- “Plan my Moodle work for this week.”
- “Download the slides from this Moodle link.”
- “Find forum posts about the next assessment.”

If the student has no upcoming items, say so and use their enrolled units to suggest relevant requests. Report the verified Moodle site and account, but omit session values and internal credentials.
