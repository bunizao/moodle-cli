export type RenewalReasonCode =
  | "SESSION_VALID"
  | "SESSION_EXPIRING"
  | "SESSION_EXPIRED"
  | "SESSION_SYNC_STALE"
  | "MOODLE_UNREACHABLE"
  | "RENEWAL_AGENT_MISSING";

export type ReplacementSession =
  | { source: "browser" | "okta"; fingerprintChanged: boolean; valid: boolean }
  | { source: "none" | "mfa_required" };

export interface RenewalSnapshot {
  remote: "valid" | "expiring" | "expired" | "unreachable";
  replacement: ReplacementSession;
  upload: "idle" | "interrupted" | "revision_conflict";
  agentInstalled: boolean;
}

export type RenewalAction =
  | { type: "install_agent" }
  | { type: "preserve_session" }
  | { type: "validate_and_upload"; source: "browser" | "okta" }
  | { type: "retry_upload" }
  | { type: "refresh_remote_revision" }
  | { type: "notify_sign_in" }
  | { type: "none" };

export interface RenewalDecision {
  state: "healthy" | "renewing" | "needs_sign_in" | "offline" | "conflict";
  reasonCode: RenewalReasonCode;
  actions: RenewalAction[];
}

export function decideRenewal(snapshot: RenewalSnapshot): RenewalDecision {
  const installAction: RenewalAction[] = snapshot.agentInstalled ? [] : [{ type: "install_agent" }];

  if (snapshot.remote === "unreachable") {
    return {
      state: "offline",
      reasonCode: "MOODLE_UNREACHABLE",
      actions: [...installAction, { type: "preserve_session" }],
    };
  }

  if (snapshot.upload === "revision_conflict") {
    return {
      state: "conflict",
      reasonCode: "SESSION_SYNC_STALE",
      actions: [...installAction, { type: "refresh_remote_revision" }],
    };
  }

  if (snapshot.upload === "interrupted") {
    return {
      state: "renewing",
      reasonCode: "SESSION_SYNC_STALE",
      actions: [...installAction, { type: "retry_upload" }],
    };
  }

  if (snapshot.remote === "valid") {
    return {
      state: "healthy",
      reasonCode: snapshot.agentInstalled ? "SESSION_VALID" : "RENEWAL_AGENT_MISSING",
      actions: installAction.length ? installAction : [{ type: "none" }],
    };
  }

  if (
    (snapshot.replacement.source === "browser" || snapshot.replacement.source === "okta")
    && snapshot.replacement.valid
    && snapshot.replacement.fingerprintChanged
  ) {
    return {
      state: "renewing",
      reasonCode: snapshot.remote === "expired" ? "SESSION_EXPIRED" : "SESSION_EXPIRING",
      actions: [...installAction, { type: "validate_and_upload", source: snapshot.replacement.source }],
    };
  }

  if (snapshot.replacement.source === "mfa_required") {
    return {
      state: "needs_sign_in",
      reasonCode: snapshot.remote === "expired" ? "SESSION_EXPIRED" : "SESSION_EXPIRING",
      actions: [...installAction, { type: "notify_sign_in" }],
    };
  }

  if (snapshot.remote === "expired") {
    return {
      state: "needs_sign_in",
      reasonCode: "SESSION_EXPIRED",
      actions: [...installAction, { type: "notify_sign_in" }],
    };
  }

  return {
    state: "healthy",
    reasonCode: "SESSION_EXPIRING",
    actions: installAction.length ? installAction : [{ type: "none" }],
  };
}

export interface RenewalActionExecutor {
  installAgent(): Promise<void>;
  validateAndUpload(source: "browser" | "okta"): Promise<void>;
  retryUpload(): Promise<void>;
  refreshRemoteRevision(): Promise<void>;
  notifySignIn(): Promise<void>;
}

export async function executeRenewalDecision(
  decision: RenewalDecision,
  executor: RenewalActionExecutor,
): Promise<void> {
  for (const action of decision.actions) {
    switch (action.type) {
      case "install_agent":
        await executor.installAgent();
        break;
      case "validate_and_upload":
        await executor.validateAndUpload(action.source);
        break;
      case "retry_upload":
        await executor.retryUpload();
        break;
      case "refresh_remote_revision":
        await executor.refreshRemoteRevision();
        break;
      case "notify_sign_in":
        await executor.notifySignIn();
        break;
      case "preserve_session":
      case "none":
        break;
    }
  }
}
