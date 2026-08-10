import { describe, expect, it } from "vitest";
import {
  ONBOARDING_COPY,
  clientConfigurationFailedCopy,
  formatOnboardingStage,
  moodleUnavailableCopy,
  successfulDeploymentCopy,
} from "../src/mcp/deployment/index.js";

describe("managed deployment onboarding copy", () => {
  it("keeps first-run, login, and Cloudflare prompts stable", () => {
    expect(ONBOARDING_COPY.introduction).toMatchInlineSnapshot(`
      "Moodle MCP setup

      This command will:
        • verify your Moodle sign-in
        • deploy a private MCP server to your Cloudflare account
        • install session renewal on this computer
        • connect supported MCP clients

      Your Moodle password and session cookie will not be printed or stored in this project."
    `);
    expect(ONBOARDING_COPY.credentials).toContain("MCP access token");
    expect(ONBOARDING_COPY.credentials).toContain("Session sync token");
    expect(ONBOARDING_COPY.credentials).toContain("They will not appear in Wrangler arguments, logs, or project files.");
    expect(ONBOARDING_COPY.nonInteractiveSignIn).toContain("moodle mcp deploy --yes");
    expect(ONBOARDING_COPY.cloudflareSignIn).toContain("Wrangler will open Cloudflare's authorization page");
    expect(formatOnboardingStage("deploy_candidate_version", "pending")).toBe("[5/8] Deploying candidate version");
    expect(formatOnboardingStage("deploy_candidate_version", "completed")).toBe("✓ [5/8] Deploying candidate version");
  });

  it("renders a stable, secret-free success report", () => {
    const output = successfulDeploymentCopy({
      endpoint: "https://moodle-school.demo.workers.dev/mcp",
      moodleSite: "https://moodle.example.edu",
      moodleUser: "Alice Example",
      clients: ["Codex", "Claude Desktop"],
    });
    expect(output).toContain("Moodle MCP is ready.");
    expect(output).toContain("MCP 2026-07-28");
    expect(output).toContain("Stateless legacy compatibility: 2025-11-25");
    expect(output).toContain("  ✓ Codex\n  ✓ Claude Desktop");
    expect(output).not.toMatch(/Bearer|MoodleSession|token/i);
  });

  it("distinguishes upstream failure from sign-in and preserves client rollback copy", () => {
    expect(moodleUnavailableCopy("https://moodle.example.edu")).toContain("current session has been preserved");
    expect(moodleUnavailableCopy("https://moodle.example.edu")).toContain("No login is required yet");
    expect(clientConfigurationFailedCopy("Codex")).toContain("No existing client configuration was overwritten");
    expect(ONBOARDING_COPY.productionRestored).toContain("previous healthy release");
  });
});
