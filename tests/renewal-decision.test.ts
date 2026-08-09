import { describe, expect, it, vi } from "vitest";
import {
  decideRenewal,
  executeRenewalDecision,
  sendRenewalNotification,
  type RenewalActionExecutor,
  type RenewalSnapshot,
} from "../src/mcp/renewal/index.js";

const HEALTHY: RenewalSnapshot = {
  remote: "valid",
  replacement: { source: "none" },
  upload: "idle",
  agentInstalled: true,
};

describe("renewal decision state machine", () => {
  it.each([
    ["valid remote session", HEALTHY, "SESSION_VALID", [{ type: "none" }]],
    ["renewal job missing", { ...HEALTHY, agentInstalled: false }, "RENEWAL_AGENT_MISSING", [{ type: "install_agent" }]],
    ["session approaching expiry", { ...HEALTHY, remote: "expiring" }, "SESSION_EXPIRING", [{ type: "none" }]],
    [
      "fresh browser session",
      { ...HEALTHY, remote: "expired", replacement: { source: "browser", valid: true, fingerprintChanged: true } },
      "SESSION_EXPIRED",
      [{ type: "validate_and_upload", source: "browser" }],
    ],
    [
      "fresh Okta session",
      { ...HEALTHY, remote: "expiring", replacement: { source: "okta", valid: true, fingerprintChanged: true } },
      "SESSION_EXPIRING",
      [{ type: "validate_and_upload", source: "okta" }],
    ],
    [
      "MFA required",
      { ...HEALTHY, remote: "expired", replacement: { source: "mfa_required" } },
      "SESSION_EXPIRED",
      [{ type: "notify_sign_in" }],
    ],
    [
      "Moodle unreachable",
      { ...HEALTHY, remote: "unreachable" },
      "MOODLE_UNREACHABLE",
      [{ type: "preserve_session" }],
    ],
    [
      "session upload interrupted",
      { ...HEALTHY, remote: "expired", upload: "interrupted" },
      "SESSION_SYNC_STALE",
      [{ type: "retry_upload" }],
    ],
    [
      "stale computer revision",
      { ...HEALTHY, remote: "expired", upload: "revision_conflict" },
      "SESSION_SYNC_STALE",
      [{ type: "refresh_remote_revision" }],
    ],
    [
      "expired without replacement",
      { ...HEALTHY, remote: "expired" },
      "SESSION_EXPIRED",
      [{ type: "notify_sign_in" }],
    ],
  ] as const)("handles %s", (_name, snapshot, reasonCode, actions) => {
    expect(decideRenewal(snapshot as RenewalSnapshot)).toMatchObject({ reasonCode, actions });
  });

  it("executes only the selected non-interactive actions", async () => {
    const executor: RenewalActionExecutor = {
      installAgent: vi.fn(async () => undefined),
      validateAndUpload: vi.fn(async () => undefined),
      retryUpload: vi.fn(async () => undefined),
      refreshRemoteRevision: vi.fn(async () => undefined),
      notifySignIn: vi.fn(async () => undefined),
    };
    await executeRenewalDecision(decideRenewal({
      ...HEALTHY,
      remote: "expired",
      replacement: { source: "browser", valid: true, fingerprintChanged: true },
      agentInstalled: false,
    }), executor);
    expect(executor.installAgent).toHaveBeenCalledOnce();
    expect(executor.validateAndUpload).toHaveBeenCalledWith("browser");
    expect(executor.notifySignIn).not.toHaveBeenCalled();
  });
});

describe("renewal notifications", () => {
  it("sends fixed copy without profile, cookie, token, or upstream error details", async () => {
    const sender = { send: vi.fn(async () => undefined) };
    await sendRenewalNotification("sign_in_required", sender);
    expect(sender.send).toHaveBeenCalledWith({
      title: "Moodle MCP needs sign-in",
      body: "Your Moodle session expired. Run `moodle mcp login` to restore remote access.",
    });
    expect(JSON.stringify(sender.send.mock.calls)).not.toMatch(/MoodleSession|Bearer|cookieValue/);
  });
});
