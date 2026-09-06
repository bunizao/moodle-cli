import { describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_COPY,
  clientConfigurationFailedCopy,
  createProgressReporter,
  formatOnboardingStage,
  moodleUnavailableCopy,
  successfulDeploymentCopy,
} from "../src/mcp/deployment/index.js";

function collectingStream(): { stream: NodeJS.WritableStream; written: () => string } {
  let buffer = "";
  const stream = { write: (chunk: string) => { buffer += chunk; return true; } };
  return { stream: stream as unknown as NodeJS.WritableStream, written: () => buffer };
}

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

describe("deployment progress reporter", () => {
  it("animates the running step and replaces it once the step completes", () => {
    vi.useFakeTimers();
    try {
      const target = collectingStream();
      let clock = 0;
      const progress = createProgressReporter({
        stream: target.stream,
        interactive: true,
        intervalMs: 100,
        now: () => clock,
      });

      progress.begin("[5/8] Deploying candidate version");
      clock = 4000;
      vi.advanceTimersByTime(300);
      const duringStep = target.written();
      expect(duringStep).toContain("[5/8] Deploying candidate version");
      expect(duringStep).toContain("4s");
      expect(duringStep).not.toContain("\n");

      progress.end("\u2713 [5/8] Deploying candidate version");
      expect(target.written()).toMatch(/\u2713 \[5\/8\] Deploying candidate version\n$/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes only completed steps when the stream is not a terminal", () => {
    const target = collectingStream();
    const progress = createProgressReporter({ stream: target.stream, interactive: false });

    progress.begin("[1/8] Validating Moodle session");
    expect(target.written()).toBe("");

    progress.end("\u2713 [1/8] Validating Moodle session");
    expect(target.written()).toBe("\u2713 [1/8] Validating Moodle session\n");
  });

  it("leaves no unfinished line behind when a step is abandoned", () => {
    vi.useFakeTimers();
    try {
      const target = collectingStream();
      const progress = createProgressReporter({ stream: target.stream, interactive: true, now: () => 0 });

      progress.begin("[2/8] Checking Cloudflare access");
      progress.clear();
      const cleared = target.written();
      // The final write must be an erase, so the failure message starts on a clean line.
      expect(cleared.endsWith("\r\u001B[2K")).toBe(true);

      vi.advanceTimersByTime(1000);
      expect(target.written()).toBe(cleared);
    } finally {
      vi.useRealTimers();
    }
  });
});
