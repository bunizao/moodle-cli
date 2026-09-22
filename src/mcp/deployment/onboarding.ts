import { createTheme, type Theme } from "@bunizao/cli-kit";

import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "../protocol.js";
import type { RenewalJobDescription } from "../renewal/installers.js";

// Copy is rendered plain unless a caller hands over the CLI's theme.
const PLAIN = createTheme(false);

export const ONBOARDING_STAGES = [
  { id: "validate_moodle_session", index: 1, label: "Validating Moodle session" },
  { id: "check_cloudflare_access", index: 2, label: "Checking Cloudflare access" },
  { id: "prepare_worker_release", index: 3, label: "Preparing Worker release" },
  { id: "upload_private_credentials", index: 4, label: "Uploading private credentials" },
  { id: "deploy_candidate_version", index: 5, label: "Deploying candidate version" },
  { id: "upload_moodle_session", index: 6, label: "Uploading Moodle session" },
  { id: "run_release_checks", index: 7, label: "Running MCP and Moodle checks" },
  { id: "install_local_integrations", index: 8, label: "Installing renewal and client connection" },
] as const;

export type OnboardingStageId = (typeof ONBOARDING_STAGES)[number]["id"];

export const ONBOARDING_COPY = {
  introduction: [
    "Creates a private Moodle MCP Worker in your Cloudflare account.",
    "Uploads your Moodle session over HTTPS; the Worker stores it encrypted.",
    "Installs local session renewal and connects supported MCP clients.",
    "Cloudflare's free tier costs $0 within its limits; paid usage follows your account plan.",
  ].join("\n"),
  credentials: [
    "Moodle MCP will create two private credentials:",
    "",
    "  MCP access token",
    "  Allows MCP clients to read data exposed by this server.",
    "",
    "  Session sync token",
    "  Allows this computer to replace the Worker's Moodle session.",
    "",
    "The credentials will be stored in your operating system credential store. They will not appear in Wrangler arguments, logs, or project files.",
  ].join("\n"),
  noActiveSession: [
    "No active Moodle session was found.",
    "",
    "I can open the Moodle sign-in page in your browser. Complete your normal sign-in, including MFA. This terminal will wait for Moodle to finish the login.",
  ].join("\n"),
  waitingForSignIn: [
    "Waiting for Moodle sign-in...",
    "You may return to this terminal after the Moodle dashboard appears.",
  ].join("\n"),
  signInTimeout: [
    "Moodle sign-in did not finish within 2 minutes.",
    "",
    "The browser window can remain open. Complete the sign-in, then run:",
    "",
    "  moodle mcp login",
  ].join("\n"),
  nonInteractiveSignIn: [
    "Moodle sign-in requires user input.",
    "",
    "Run this command in an interactive terminal:",
    "",
    "  moodle mcp login",
    "",
    "Then repeat:",
    "",
    "  moodle mcp deploy --yes",
  ].join("\n"),
  cloudflareSignIn: [
    "Cloudflare sign-in is required.",
    "",
    "Wrangler will open Cloudflare's authorization page. moodle-cli will not receive your Cloudflare password.",
  ].join("\n"),
  sessionExpired: [
    "Moodle MCP needs sign-in.",
    "",
    "The remote server is running, but Moodle rejected its session.",
    "",
    "Run:",
    "",
    "  moodle mcp login",
  ].join("\n"),
  candidateFailed: [
    "Cloudflare accepted the candidate Worker, but the release failed validation.",
    "",
    "Production traffic was not changed.",
  ].join("\n"),
  productionRestored: [
    "The new release failed its production check.",
    "",
    "moodle-cli restored the previous healthy release with the current credentials and Moodle session.",
    "",
    "Current status: ready",
  ].join("\n"),
  cloudflareAuthorizationExpired: [
    "Cloudflare authorization has expired.",
    "",
    "Run:",
    "",
    "  moodle mcp deploy --repair",
    "",
    "Wrangler will request Cloudflare authorization again.",
  ].join("\n"),
} as const;

export function formatOnboardingStage(
  stageId: OnboardingStageId,
  status: "pending" | "completed",
  theme: Theme = PLAIN,
): string {
  const stage = ONBOARDING_STAGES.find((item) => item.id === stageId);
  if (!stage) {
    throw new Error(`Unknown onboarding stage: ${stageId}`);
  }
  const line = `[${stage.index}/8] ${stage.label}`;
  return status === "completed" ? `${theme.tone("success", "✓")} ${line}` : line;
}

export function successfulDeploymentCopy(input: {
  endpoint: string;
  moodleSite: string;
  moodleUser: string;
  clients: string[];
  renewal?: RenewalJobDescription;
}, theme: Theme = PLAIN): string {
  const connectedClients = input.clients.length
    ? input.clients.map((client) => `  ${theme.tone("success", "✓")} ${client}`).join("\n")
    : `  ${theme.dim("No supported clients detected")}`;
  const field = (label: string, value: string) => `  ${theme.dim(`${label}:`)} ${value}`;
  return [
    theme.tone("success", "Moodle MCP is ready."),
    "",
    theme.subject("Endpoint"),
    // The one line a person copies into a client, so it reads as an identifier, not a footnote.
    `  ${theme.key(input.endpoint)}`,
    "",
    theme.subject("Protocol"),
    `  ${theme.dim("MCP")} ${MODERN_PROTOCOL_VERSION}`,
    `  ${theme.dim(`Stateless legacy compatibility: ${LEGACY_PROTOCOL_VERSION}`)}`,
    "",
    theme.subject("Moodle"),
    field("Site", theme.target(input.moodleSite)),
    field("User", input.moodleUser),
    field("Session", theme.status("ready", { ready: "success" })),
    "",
    theme.subject("Renewal"),
    // People did not ask for a scheduler, so the first thing to say is what they will
    // notice: nothing, unless Moodle signs them out. The mechanics come last and dim.
    "  A silent background check every 30 minutes; you never see it.",
    `  If Moodle signs you out it re-uploads your browser cookie, or sends one notification to run ${theme.key("moodle mcp login")}.`,
    ...(input.renewal ? [`  ${theme.dim(`${input.renewal.scheduler} ${input.renewal.label} · log ${input.renewal.log} · remove with moodle mcp remove`)}`] : []),
    "",
    theme.subject("Connected clients"),
    connectedClients,
  ].join("\n");
}

export function moodleUnavailableCopy(moodleSite: string, theme: Theme = PLAIN): string {
  return [
    `Moodle MCP cannot reach ${theme.target(moodleSite)}.`,
    "",
    "The current session has been preserved. No login is required yet.",
    "",
    "Try again with:",
    "",
    `  ${theme.key("moodle mcp status")}`,
  ].join("\n");
}

export function clientConfigurationFailedCopy(client: string, theme: Theme = PLAIN): string {
  return [
    `The MCP server is ready, but ${theme.target(client)} configuration could not be updated.`,
    "",
    "No existing client configuration was overwritten.",
    "",
    "Run:",
    "",
    `  ${theme.key(`moodle mcp connect ${client.toLowerCase()}`)}`,
  ].join("\n");
}
