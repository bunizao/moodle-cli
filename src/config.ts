import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { createUi, isAgentEnvironment, type Ui } from "@bunizao/cli-kit";

import { showWordmark } from "./wordmark.js";
import YAML from "yaml";
import { CONFIG_DIR_NAME, CONFIG_FILENAME, ENV_MOODLE_BASE_URL, ENV_MOODLE_CONFIG, ENV_MOODLE_URL } from "./constants.js";
import { ConfigError } from "./errors.js";
import { writeFileAtomic } from "./atomic-write.js";
import { discoverSite, parseSiteInput, type DiscoveredSite } from "./site-discovery.js";

export interface MoodleConfig extends Record<string, unknown> {
  baseUrl: string;
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
  write: (path: string, content: string) => Promise<void>;
}

const nodeFs: ConfigFs = { readFile, write: (path, content) => writeFileAtomic(path, content) };

export function cwdConfigPath(cwd = process.cwd()): string {
  return join(cwd, CONFIG_FILENAME);
}

export function userConfigPath(homeDir = homedir()): string {
  return join(homeDir, CONFIG_DIR_NAME, CONFIG_FILENAME);
}

/**
 * Normalize a configured site root. Moodle may be installed under any path, so a path is
 * kept; what this cannot tell is whether the path is the install root or a page inside
 * it. Interactive setup answers that by asking the site (see site-discovery.ts).
 */
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

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
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
  // An injected prompt (tests) means plain lines; a real terminal gets the guided setup.
  const ui = createUi({ input: process.stdin, output: (options.stderr ?? process.stderr) as Writable, ...(options.prompt ? { interactive: false } : {}) });
  const prompt = options.prompt ?? defaultPrompt(ui);
  const confirm = async (message: string): Promise<boolean> =>
    ui.interactive ? ui.confirm(message, { initial: true }) : /^y/iu.test((await prompt(`${message} (y/n)`)).trim());
  showWordmark(ui);
  ui.intro("Moodle setup");
  ui.note([
    "Paste the address of your Moodle site. Any page works: the front page, your dashboard, or a course.",
    "The address is checked with the site itself, so a site under a path such as /moodle is found too.",
    `Runtime: ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`}. Browser SQLite needs Bun or Node 22.13+. Run moodle doctor for diagnostics.`,
  ].join("\n"), "Connect to Moodle");

  while (true) {
    let input: URL;
    try {
      input = parseSiteInput(await prompt("Moodle address"));
    } catch (error) {
      ui.warn(error instanceof Error ? error.message : String(error));
      continue;
    }

    const spin = ui.spinner();
    spin.start(`Looking for Moodle at ${input.host}`);
    const result = await discoverSite(input, { fetch: options.fetch });
    switch (result.kind) {
      case "found":
        spin.stop(`Found ${describeSite(result.site)}`);
        return result.site.root;
      case "elsewhere":
        spin.stop(`${input.host} leads to ${describeSite(result.site)}`);
        if (await confirm(`Use ${result.site.root}?`)) return result.site.root;
        break;
      case "redirected":
        spin.error(`${input.host} sends you on to ${result.host}, which is not Moodle`);
        ui.info("If that is your sign-in page, sign in, then paste the address of any Moodle page you land on.");
        break;
      case "not_found":
        spin.error(`No Moodle found at ${input.host}${input.pathname === "/" ? "" : input.pathname}`);
        ui.info("Open Moodle in your browser and paste the address of any page there, such as a course.");
        break;
      case "unreachable":
        spin.error(result.message);
        break;
    }
  }
}

function describeSite(site: DiscoveredSite): string {
  return site.sitename ? `${site.sitename} at ${site.root}` : site.root;
}

export function missingBaseUrlMessage(configPath: string | null, options: ConfigOptions = {}): string {
  const targetPath = configPath ?? userConfigPath(options.homeDir);
  return [
    "No base_url configured.",
    `Add base_url to ${targetPath} or set MOODLE_BASE_URL.`,
    "Required format:",
    "  base_url: https://school.example.edu",
    "Use the address Moodle lives at, with its path if it has one, for example https://school.example.edu/moodle.",
    "Run `moodle` in an interactive shell to have it found from any page address.",
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
  await fs.write(path, YAML.stringify(config, { sortMapEntries: true }));
}

function toMoodleConfig(config: Record<string, unknown>, baseUrl: string): MoodleConfig {
  const { base_url: _baseUrl, ...rest } = config;
  return { ...rest, baseUrl };
}

function defaultPrompt(ui: Ui): (label: string) => Promise<string> {
  return (label) => ui.text(label, { placeholder: "https://school.example.edu/my/" });
}

// Only a person gets the setup prompt. An agent shell with a pty is told what to set instead.
function isInteractive(options: ConfigOptions): boolean {
  return Boolean((options.stdin ?? process.stdin).isTTY) && !isAgentEnvironment(options.env ?? process.env);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
