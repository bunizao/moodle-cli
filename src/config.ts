import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import YAML from "yaml";
import { CONFIG_DIR_NAME, CONFIG_FILENAME, ENV_MOODLE_BASE_URL, ENV_MOODLE_CONFIG, ENV_MOODLE_URL } from "./constants.js";
import { ConfigError } from "./errors.js";

export interface MoodleConfig extends Record<string, unknown> {
  baseUrl: string;
}

export interface ProbeResult {
  ok: boolean;
  message?: string;
}

export interface ConfigOptions {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  stdin?: Pick<NodeJS.ReadStream, "isTTY">;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  prompt?: (label: string) => Promise<string>;
  fetch?: typeof fetch;
  fs?: ConfigFs;
}

export interface ConfigFs {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
}

const nodeFs: ConfigFs = { readFile, writeFile, mkdir };

export function cwdConfigPath(cwd = process.cwd()): string {
  return join(cwd, CONFIG_FILENAME);
}

export function userConfigPath(homeDir = homedir()): string {
  return join(homeDir, CONFIG_DIR_NAME, CONFIG_FILENAME);
}

export function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) {
    throw new ConfigError("Base URL cannot be empty.");
  }
  if (!raw.includes("://")) {
    throw new ConfigError("Base URL must include the scheme, for example https://school.example.edu");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError("Base URL must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("Base URL must start with http:// or https://");
  }
  if (!parsed.hostname) {
    throw new ConfigError("Base URL must include a hostname");
  }
  if (parsed.search || parsed.hash) {
    throw new ConfigError("Base URL must not include query parameters or fragments");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new ConfigError(
      "Base URL must be the site root, for example https://school.example.edu. Do not include paths like /login/index.php or /my/.",
    );
  }

  return parsed.origin;
}

export async function loadConfig(options: ConfigOptions = {}): Promise<MoodleConfig> {
  const env = options.env ?? process.env;
  if (env[ENV_MOODLE_BASE_URL]) {
    return { baseUrl: normalizeBaseUrl(env[ENV_MOODLE_BASE_URL]) };
  }
  if (env[ENV_MOODLE_URL]) {
    (options.stderr ?? process.stderr).write(`${ENV_MOODLE_URL} is deprecated; use ${ENV_MOODLE_BASE_URL}.\n`);
    return { baseUrl: normalizeBaseUrl(env[ENV_MOODLE_URL]) };
  }

  const loaded = await loadExistingConfig(options);
  if (loaded.config.base_url) {
    return toMoodleConfig(loaded.config, normalizeBaseUrl(String(loaded.config.base_url)));
  }

  if (!isInteractive(options)) {
    throw new ConfigError(missingBaseUrlMessage(loaded.path, options), "Set MOODLE_BASE_URL or run `moodle` once in an interactive shell.");
  }

  const baseUrl = await promptForBaseUrl(options);
  const targetPath = loaded.path ?? userConfigPath(options.homeDir);
  await saveConfigFile(targetPath, { ...loaded.config, base_url: baseUrl }, options);
  return toMoodleConfig(loaded.config, baseUrl);
}

export async function promptForBaseUrl(options: ConfigOptions = {}): Promise<string> {
  const prompt = options.prompt ?? defaultPrompt(options);
  const output = options.stderr ?? process.stderr;
  output.write("Configuration required\n");
  output.write("Moodle base URL is not configured yet.\n");
  output.write("Required format: https://school.example.edu\n");
  output.write("Use the site root only. Do not include paths like /login/index.php or /my/.\n");

  while (true) {
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(await prompt("Moodle base URL"));
    } catch (error) {
      output.write(`Invalid URL: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }

    const probe = await probeBaseUrl(baseUrl, options);
    if (probe.ok) {
      return baseUrl;
    }
    output.write(`Validation failed: ${probe.message ?? "site did not look like Moodle"}\n`);
  }
}

export async function probeBaseUrl(baseUrl: string, options: ConfigOptions = {}): Promise<ProbeResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) {
    return { ok: false, message: "fetch is not available in this runtime" };
  }

  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/login/token.php`, { redirect: "follow" });
  } catch (error) {
    return { ok: false, message: `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}` };
  }

  const body = (await response.text()).slice(0, 5000).toLowerCase();
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const looksJson = contentType.includes("application/json") || body.startsWith("{");
  const looksMoodleTokenError = [
    '"errorcode":"missingparam"',
    '"errorcode":"invalidparameter"',
    '"errorcode":"invalidlogin"',
    "a required parameter (username) was missing",
  ].some((marker) => body.includes(marker));
  const looksMoodleHtml = body.includes("moodle") && (body.includes("login") || body.includes("sesskey"));

  if (response.status >= 400) {
    return { ok: false, message: `${baseUrl} returned HTTP ${response.status}` };
  }
  if ((looksJson && looksMoodleTokenError) || looksMoodleHtml) {
    return { ok: true };
  }
  return { ok: false, message: `${baseUrl} does not expose the expected Moodle token endpoint` };
}

export function missingBaseUrlMessage(configPath: string | null, options: ConfigOptions = {}): string {
  const targetPath = configPath ?? userConfigPath(options.homeDir);
  return [
    "No base_url configured.",
    `Add base_url to ${targetPath} or set MOODLE_BASE_URL.`,
    "Required format:",
    "  base_url: https://school.example.edu",
    "Use the site root only. Do not include paths like /login/index.php or /my/.",
  ].join("\n");
}

async function loadExistingConfig(options: ConfigOptions): Promise<{ config: Record<string, unknown>; path: string | null }> {
  const env = options.env ?? process.env;
  const explicitPath = env[ENV_MOODLE_CONFIG];
  const paths = [explicitPath, cwdConfigPath(options.cwd), userConfigPath(options.homeDir)].filter(
    (value): value is string => Boolean(value),
  );
  for (const path of paths) {
    const config = await readConfigFile(path, options);
    if (config) {
      return { config, path };
    }
  }
  return { config: {}, path: explicitPath ?? null };
}

async function readConfigFile(path: string, options: ConfigOptions): Promise<Record<string, unknown> | null> {
  const fs = options.fs ?? nodeFs;
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  const parsed = YAML.parse(raw) ?? {};
  if (!isRecord(parsed)) {
    throw new ConfigError(`${path} must contain a YAML object.`);
  }
  return parsed;
}

async function saveConfigFile(path: string, config: Record<string, unknown>, options: ConfigOptions): Promise<void> {
  const fs = options.fs ?? nodeFs;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, YAML.stringify(config, { sortMapEntries: true }), "utf8");
}

function toMoodleConfig(config: Record<string, unknown>, baseUrl: string): MoodleConfig {
  const { base_url: _baseUrl, ...rest } = config;
  return { ...rest, baseUrl };
}

function defaultPrompt(options: ConfigOptions): (label: string) => Promise<string> {
  return async (label: string): Promise<string> => {
    const rl = createInterface({
      input: process.stdin,
      output: options.stdout ?? process.stdout,
    });
    try {
      return await rl.question(`${label} > `);
    } finally {
      rl.close();
    }
  };
}

function isInteractive(options: ConfigOptions): boolean {
  return Boolean((options.stdin ?? process.stdin).isTTY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
