import { VERBS, type CommandDescription, type ProgramDescription } from "@bunizao/cli-kit";
import type { Argument, Command, Option } from "commander";

const VERB_SET = new Set<string>(VERBS);

export function describeProgram(program: Command): ProgramDescription {
  return {
    name: program.name(),
    version: program.version() ?? "",
    description: program.description(),
    commands: program.commands
      .filter((command) => command.name() !== "help")
      .map((command) => describeCommand(command)),
  };
}

function describeCommand(command: Command, noun?: string): CommandDescription {
  const currentNoun = noun ?? command.name();
  const verb = noun && VERB_SET.has(command.name()) ? command.name() : undefined;
  return {
    name: command.name(),
    noun: currentNoun,
    ...(verb ? { verb } : {}),
    aliases: command.aliases(),
    description: command.description(),
    positionals: command.registeredArguments.map(describeArgument),
    options: command.options.map(describeOption),
    mutating: isMutating(command),
    commands: command.commands
      .filter((child) => child.name() !== "help")
      .map((child) => describeCommand(child, currentNoun)),
  };
}

function describeArgument(argument: Argument): CommandDescription["positionals"][number] {
  return {
    name: argument.name(),
    description: argument.description,
    required: argument.required,
    variadic: argument.variadic,
    ...(argument.argChoices ? { enumValues: argument.argChoices } : {}),
  };
}

function describeOption(option: Option): CommandDescription["options"][number] {
  return {
    flags: option.flags,
    description: option.description,
    required: option.required,
    variadic: option.variadic,
    ...(option.argChoices ? { enumValues: option.argChoices } : {}),
  };
}

function isMutating(command: Command): boolean {
  if (VERB_SET.has(command.name())) {
    return ["send", "submit", "set", "mark-read"].includes(command.name());
  }
  return ["install", "uninstall", "login", "deploy", "connect", "pair", "revoke", "remove", "push"].includes(command.name());
}
