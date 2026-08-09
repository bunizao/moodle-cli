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
    "Moodle MCP setup",
    "",
    "This command will:",
    "  • verify your Moodle sign-in",
    "  • deploy a private MCP server to your Cloudflare account",
    "  • install session renewal on this computer",
    "  • connect supported MCP clients",
    "",
    "Your Moodle password and session cookie will not be printed or stored in this project.",
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
): string {
  const stage = ONBOARDING_STAGES.find((item) => item.id === stageId);
  if (!stage) {
    throw new Error(`Unknown onboarding stage: ${stageId}`);
  }
  const line = `[${stage.index}/8] ${stage.label}`;
  return status === "completed" ? `✓ ${line}` : line;
}

export function successfulDeploymentCopy(input: {
  endpoint: string;
  moodleSite: string;
  moodleUser: string;
  clients: string[];
}): string {
  const connectedClients = input.clients.length
    ? input.clients.map((client) => `  ✓ ${client}`).join("\n")
    : "  No supported clients detected";
  return [
    "Moodle MCP is ready.",
    "",
    "Endpoint",
    `  ${input.endpoint}`,
    "",
    "Protocol",
    "  MCP 2026-07-28",
    "  Stateless legacy compatibility: 2025-11-25",
    "",
    "Moodle",
    `  Site: ${input.moodleSite}`,
    `  User: ${input.moodleUser}`,
    "  Session: ready",
    "",
    "Renewal",
    "  Installed on this computer",
    "  Next check: within 30 minutes",
    "",
    "Connected clients",
    connectedClients,
    "",
    "Run `moodle mcp status` at any time.",
  ].join("\n");
}

export function moodleUnavailableCopy(moodleSite: string): string {
  return [
    `Moodle MCP cannot reach ${moodleSite}.`,
    "",
    "The current session has been preserved. No login is required yet.",
    "",
    "Try again with:",
    "",
    "  moodle mcp status",
  ].join("\n");
}

export function clientConfigurationFailedCopy(client: string): string {
  return [
    `The MCP server is ready, but ${client} configuration could not be updated.`,
    "",
    "No existing client configuration was overwritten.",
    "",
    "Run:",
    "",
    `  moodle mcp connect ${client.toLowerCase()}`,
  ].join("\n");
}
