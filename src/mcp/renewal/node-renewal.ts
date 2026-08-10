import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { buildRenewalInstallPlan, RenewalInstaller, type RenewalInstallerIO, type RenewalPlatform } from "./installers.js";
import { sendRenewalNotification, type RenewalNotification, type RenewalNotificationSender } from "./notifications.js";

const execFile = promisify(execFileCallback);

export class NodeRenewalInstallerIO implements RenewalInstallerIO {
  async writePrivate(path: string, content: string, mode: 0o600): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { encoding: "utf8", mode });
    await chmod(path, mode);
  }

  async removeFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  async run(command: string, args: string[], options: { ignoreFailure?: boolean } = {}): Promise<void> {
    try {
      await execFile(command, args, { windowsHide: true });
    } catch (error) {
      if (!options.ignoreFailure) {
        throw error;
      }
    }
  }
}

export interface DefaultRenewalOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  executable?: string;
  uid?: number;
  intervalMinutes?: number;
  io?: RenewalInstallerIO;
}

export function createDefaultRenewalInstaller(
  profile: string,
  options: DefaultRenewalOptions = {},
): RenewalInstaller {
  const platform = options.platform ?? process.platform;
  if (!isSupportedPlatform(platform)) {
    throw new Error(`Moodle MCP renewal is not supported on ${platform}`);
  }
  const plan = buildRenewalInstallPlan({
    platform,
    profile,
    executable: options.executable ?? process.argv[1] ?? process.execPath,
    homeDirectory: options.homeDirectory ?? homedir(),
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
    intervalMinutes: options.intervalMinutes,
  });
  return new RenewalInstaller(plan, options.io ?? new NodeRenewalInstallerIO());
}

export class DefaultRenewalIntegration {
  constructor(private readonly options: DefaultRenewalOptions = {}) {}

  install(profile: string): Promise<void> {
    return createDefaultRenewalInstaller(profile, this.options).install();
  }

  inspect(profile: string): Promise<boolean> {
    return createDefaultRenewalInstaller(profile, this.options).inspect();
  }

  remove(profile: string): Promise<void> {
    return createDefaultRenewalInstaller(profile, this.options).remove();
  }
}

export class NodeRenewalNotificationSender implements RenewalNotificationSender {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async send(notification: RenewalNotification): Promise<void> {
    if (this.platform === "darwin") {
      await execFile("osascript", [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        notification.title,
        notification.body,
      ]);
      return;
    }
    if (this.platform === "linux") {
      await execFile("notify-send", [notification.title, notification.body]);
      return;
    }
    if (this.platform === "win32") {
      const script = [
        "$title = $args[0]",
        "$body = $args[1]",
        "Add-Type -AssemblyName System.Windows.Forms",
        "$n = New-Object System.Windows.Forms.NotifyIcon",
        "$n.Icon = [System.Drawing.SystemIcons]::Information",
        "$n.BalloonTipTitle = $title",
        "$n.BalloonTipText = $body",
        "$n.Visible = $true",
        "$n.ShowBalloonTip(10000)",
      ].join(";");
      await execFile("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
        notification.title,
        notification.body,
      ], { windowsHide: true });
    }
  }
}

export function notifyRenewalSignInRequired(platform: NodeJS.Platform = process.platform): Promise<void> {
  return sendRenewalNotification("sign_in_required", new NodeRenewalNotificationSender(platform));
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is RenewalPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
