export interface SelfCommand {
  command: string;
  args: string[];
}

// GUI MCP clients and launchd/systemd/schtasks do not inherit the shell PATH, so a
// "#!/usr/bin/env node" script fails to start when node comes from a version manager.
// Spawn the exact runtime binary that is running this process instead.
export function selfCommand(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): SelfCommand {
  const script = argv[1];
  return script && script !== execPath
    ? { command: execPath, args: [script] }
    : { command: execPath, args: [] };
}

export function runtimeCommand(command?: string, args?: readonly string[]): SelfCommand {
  return command ? { command, args: [...(args ?? [])] } : selfCommand();
}
