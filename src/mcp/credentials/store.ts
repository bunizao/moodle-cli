export interface DeploymentCredentials {
  mcpAccessToken: string;
  sessionSyncToken: string;
  sessionEncryptionKey: string;
  previousMcpAccessToken?: string;
  previousSessionSyncToken?: string;
  previousTokensExpireAt?: number;
}

export const TOKEN_OVERLAP_MS = 10 * 60 * 1000;

export interface CredentialBackend {
  readonly name: string;
  read(profile: string): Promise<DeploymentCredentials | null>;
  write(profile: string, credentials: DeploymentCredentials): Promise<void>;
  delete(profile: string): Promise<void>;
}

export class CredentialBackendUnavailableError extends Error {
  constructor(backend: string, cause?: unknown) {
    super(`Credential backend ${backend} is unavailable`, { cause });
    this.name = "CredentialBackendUnavailableError";
  }
}

export class SafeCredentialStore {
  constructor(
    private readonly preferred: CredentialBackend,
    private readonly fallback: CredentialBackend,
  ) {}

  async read(profile: string): Promise<DeploymentCredentials | null> {
    let preferredValue: DeploymentCredentials | null;
    try {
      preferredValue = await this.preferred.read(profile);
    } catch (error) {
      if (!isUnavailable(error)) {
        throw error;
      }
      return this.fallback.read(profile);
    }

    return preferredValue ?? this.fallback.read(profile);
  }

  async write(profile: string, credentials: DeploymentCredentials): Promise<void> {
    try {
      await this.preferred.write(profile, credentials);
    } catch (error) {
      if (!isUnavailable(error)) {
        throw error;
      }
      await this.fallback.write(profile, credentials);
      return;
    }

    try {
      await this.fallback.delete(profile);
    } catch (error) {
      if (!isUnavailable(error)) {
        throw error;
      }
    }
  }

  async delete(profile: string): Promise<void> {
    const failures: unknown[] = [];
    for (const backend of [this.preferred, this.fallback]) {
      try {
        await backend.delete(profile);
      } catch (error) {
        if (!isUnavailable(error)) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, `Could not delete credentials for profile ${profile}`);
    }
  }
}

export function rotateCredentials(
  current: DeploymentCredentials,
  createToken: () => string,
  now: () => number = Date.now,
): DeploymentCredentials {
  return {
    mcpAccessToken: createToken(),
    sessionSyncToken: createToken(),
    sessionEncryptionKey: current.sessionEncryptionKey,
    previousMcpAccessToken: current.mcpAccessToken,
    previousSessionSyncToken: current.sessionSyncToken,
    previousTokensExpireAt: now() + TOKEN_OVERLAP_MS,
  };
}

export function createDeploymentCredentials(createToken: () => string): DeploymentCredentials {
  return {
    mcpAccessToken: createToken(),
    sessionSyncToken: createToken(),
    sessionEncryptionKey: createToken(),
  };
}

function isUnavailable(error: unknown): error is CredentialBackendUnavailableError {
  return error instanceof CredentialBackendUnavailableError;
}
