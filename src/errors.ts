import { CliError, type ErrorCode } from "@bunizao/cli-kit";

export { CliError, type ErrorCode } from "@bunizao/cli-kit";

export class AuthError extends CliError {
  constructor(message: string, hint?: string) {
    super("auth", message, hint);
  }
}

export class ConfigError extends CliError {
  constructor(message: string, hint?: string) {
    super("config", message, hint);
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super("usage", message, hint);
  }
}

export class NotFoundError extends CliError {
  constructor(message: string, hint?: string) {
    super("not_found", message, hint);
  }
}

export class MoodleAPIError extends CliError {
  readonly moodleErrorCode?: string;

  constructor(message: string, moodleErrorCode?: string) {
    const auth = isLoginErrorCode(moodleErrorCode);
    const notFound = ["invalidrecord", "invalidcoursemodule"].includes(moodleErrorCode ?? "") || /\bHTTP 404\b/.test(message);
    super(auth ? "auth" : notFound ? "not_found" : "upstream", message, auth ? "Run `moodle auth login`." : undefined);
    this.moodleErrorCode = moodleErrorCode;
  }
}

export function isLoginRequiredError(error: unknown): boolean {
  return error instanceof MoodleAPIError && isLoginErrorCode(error.moodleErrorCode);
}

export function errorCode(error: unknown): ErrorCode | undefined {
  return error instanceof CliError ? error.code : undefined;
}

function isLoginErrorCode(code: string | undefined): boolean {
  return ["servicerequireslogin", "sitepolicynotagreed"].includes(code ?? "");
}
