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
} as const;
