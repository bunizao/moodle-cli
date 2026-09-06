export type RenewalPlatform = "darwin" | "linux" | "win32";

export interface RenewalInstallOptions {
  platform: RenewalPlatform;
  profile: string;
  executable: string;
  executableArgs?: string[];
  homeDirectory: string;
  uid?: number;
  intervalMinutes?: number;
}

export interface RenewalInstallFile {
  path: string;
  content: string;
  mode: 0o600;
}

export interface RenewalInstallCommand {
  command: string;
  args: string[];
  ignoreFailure?: boolean;
}

export interface RenewalInstallPlan {
  platform: RenewalPlatform;
  profile: string;
  label: string;
  files: RenewalInstallFile[];
  installCommands: RenewalInstallCommand[];
  removeCommands: RenewalInstallCommand[];
  cleanupCommands?: RenewalInstallCommand[];
}

export interface RenewalInstallerIO {
  writePrivate(path: string, content: string, mode: 0o600): Promise<void>;
  removeFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  run(command: string, args: string[], options?: { ignoreFailure?: boolean }): Promise<void>;
}

export class RenewalInstaller {
  constructor(
    private readonly plan: RenewalInstallPlan,
    private readonly io: RenewalInstallerIO,
  ) {}

  async install(): Promise<void> {
    for (const file of this.plan.files) {
      await this.io.writePrivate(file.path, file.content, file.mode);
    }
    for (const command of this.plan.installCommands) {
      await this.io.run(command.command, command.args, { ignoreFailure: command.ignoreFailure });
    }
  }

  async inspect(): Promise<boolean> {
    const present = await Promise.all(this.plan.files.map((file) => this.io.exists(file.path)));
    return present.every(Boolean);
  }

  async remove(): Promise<void> {
    for (const command of this.plan.removeCommands) {
      await this.io.run(command.command, command.args, { ignoreFailure: command.ignoreFailure });
    }
    for (const file of this.plan.files) {
      await this.io.removeFile(file.path);
    }
    for (const command of this.plan.cleanupCommands ?? []) {
      await this.io.run(command.command, command.args, { ignoreFailure: command.ignoreFailure });
    }
  }
}

export function buildRenewalInstallPlan(options: RenewalInstallOptions): RenewalInstallPlan {
  validateOptions(options);
  const intervalMinutes = options.intervalMinutes ?? 30;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5) {
    throw new Error("Renewal interval must be at least five minutes");
  }
  switch (options.platform) {
    case "darwin":
      return macOSPlan(options, intervalMinutes);
    case "linux":
      return linuxPlan(options, intervalMinutes);
    case "win32":
      return windowsPlan(options, intervalMinutes);
  }
}

function macOSPlan(options: RenewalInstallOptions, intervalMinutes: number): RenewalInstallPlan {
  if (options.uid === undefined) {
    throw new Error("macOS renewal installation requires the current user ID");
  }
  const label = `com.moodle-cli.mcp-renewal.${options.profile}`;
  const path = `${trimEnd(options.homeDirectory, "/")}/Library/LaunchAgents/${label}.plist`;
  const target = `gui/${options.uid}`;
  // launchd discards job output unless told where to put it; ~/Library/Logs always exists.
  const logPath = `${trimEnd(options.homeDirectory, "/")}/Library/Logs/${label}.log`;
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${xml(label)}</string>`,
    "<key>ProgramArguments</key><array>",
    ...programArguments(options).map((arg) => `<string>${xml(arg)}</string>`),
    "</array>",
    `<key>StartInterval</key><integer>${intervalMinutes * 60}</integer>`,
    "<key>RunAtLoad</key><true/>",
    `<key>StandardOutPath</key><string>${xml(logPath)}</string>`,
    `<key>StandardErrorPath</key><string>${xml(logPath)}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
  return {
    platform: "darwin",
    profile: options.profile,
    label,
    files: [{ path, content: plist, mode: 0o600 }],
    installCommands: [
      { command: "launchctl", args: ["bootout", target, path], ignoreFailure: true },
      { command: "launchctl", args: ["bootstrap", target, path] },
    ],
    removeCommands: [{ command: "launchctl", args: ["bootout", target, path], ignoreFailure: true }],
  };
}

function linuxPlan(options: RenewalInstallOptions, intervalMinutes: number): RenewalInstallPlan {
  const label = `moodle-cli-mcp-renewal-${options.profile}`;
  const directory = `${trimEnd(options.homeDirectory, "/")}/.config/systemd/user`;
  const servicePath = `${directory}/${label}.service`;
  const timerPath = `${directory}/${label}.timer`;
  const command = programArguments(options).map(systemdQuote).join(" ");
  const service = [
    "[Unit]",
    `Description=Moodle MCP session renewal (${options.profile})`,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${command}`,
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    `Description=Moodle MCP session renewal timer (${options.profile})`,
    "",
    "[Timer]",
    "OnBootSec=2m",
    `OnUnitActiveSec=${intervalMinutes}m`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return {
    platform: "linux",
    profile: options.profile,
    label,
    files: [
      { path: servicePath, content: service, mode: 0o600 },
      { path: timerPath, content: timer, mode: 0o600 },
    ],
    installCommands: [
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "--now", `${label}.timer`] },
    ],
    removeCommands: [
      { command: "systemctl", args: ["--user", "disable", "--now", `${label}.timer`], ignoreFailure: true },
    ],
    cleanupCommands: [{ command: "systemctl", args: ["--user", "daemon-reload"] }],
  };
}

function windowsPlan(options: RenewalInstallOptions, intervalMinutes: number): RenewalInstallPlan {
  const label = `Moodle CLI MCP Renewal (${options.profile})`;
  const path = `${trimEnd(options.homeDirectory, "\\/")}\\AppData\\Local\\moodle-cli\\renewal\\${options.profile}.xml`;
  const argumentsText = [...(options.executableArgs ?? []), ...renewalArgs(options.profile)].map(windowsArgument).join(" ");
  const task = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "<Triggers><TimeTrigger>",
    "<StartBoundary>2000-01-01T00:00:00</StartBoundary>",
    `<Repetition><Interval>PT${intervalMinutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`,
    "<Enabled>true</Enabled>",
    "</TimeTrigger></Triggers>",
    "<Principals><Principal id=\"Author\"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
    "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable></Settings>",
    `<Actions Context="Author"><Exec><Command>${xml(options.executable)}</Command><Arguments>${xml(argumentsText)}</Arguments></Exec></Actions>`,
    "</Task>",
    "",
  ].join("\r\n");
  return {
    platform: "win32",
    profile: options.profile,
    label,
    files: [{ path, content: task, mode: 0o600 }],
    installCommands: [{ command: "schtasks.exe", args: ["/Create", "/TN", label, "/XML", path, "/F"] }],
    removeCommands: [{ command: "schtasks.exe", args: ["/Delete", "/TN", label, "/F"], ignoreFailure: true }],
  };
}

function renewalArgs(profile: string): string[] {
  return ["mcp", "renewal", "run", "--profile", profile, "--json"];
}

function programArguments(options: RenewalInstallOptions): string[] {
  return [options.executable, ...(options.executableArgs ?? []), ...renewalArgs(options.profile)];
}

function validateOptions(options: RenewalInstallOptions): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.profile)) {
    throw new Error("Invalid renewal profile name");
  }
  if (!options.executable || /[\r\n]/.test(options.executable)) {
    throw new Error("Invalid renewal executable path");
  }
  if ((options.executableArgs ?? []).some((arg) => /[\r\n]/.test(arg))) {
    throw new Error("Invalid renewal executable arguments");
  }
  if (!options.homeDirectory || /[\r\n]/.test(options.homeDirectory)) {
    throw new Error("Invalid renewal home directory");
  }
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function windowsArgument(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function trimEnd(value: string, characters: string): string {
  let end = value.length;
  while (end > 0 && characters.includes(value[end - 1] ?? "")) {
    end -= 1;
  }
  return value.slice(0, end);
}
