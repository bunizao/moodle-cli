import { getAuthenticatedSession, type AuthOptions, type AuthenticatedSession } from "./auth.js";
import {
  MoodleClientCore,
  type MoodleClientCoreOptions,
  type MoodleClientErrorAdapter,
  type MoodleSessionCookie,
} from "./moodle-client-core.js";
import { isLoginRequiredError, MoodleAPIError, NotFoundError, UsageError } from "./errors.js";
import type { SubmissionReceipt } from "./moodle-assign-core.js";
import { readSubmissionFiles, type SubmitLocalFilesRequest } from "./submit.js";
import type { PageContext } from "./models.js";
import {
  readCachedSession,
  writeCachedSession,
  type SessionCacheOptions,
} from "./session-cache.js";

export { MoodleAPIError } from "./errors.js";
export type {
  AjaxBatchResult,
  AjaxCall,
  MoodleClientCoreOptions,
  MoodleClientSessionSnapshot,
  MoodleSessionCookie,
} from "./moodle-client-core.js";

const NODE_ERROR_ADAPTER: MoodleClientErrorAdapter = {
  api: (message, moodleErrorCode) => new MoodleAPIError(message, moodleErrorCode),
  notFound: (message) => new NotFoundError(message),
  usage: (message, hint) => new UsageError(message, hint),
  isApi: (error): error is MoodleAPIError => error instanceof MoodleAPIError,
  isLoginRequired: isLoginRequiredError,
};

export class MoodleClient extends MoodleClientCore {
  constructor(baseUrl: string, options: MoodleClientCoreOptions | string) {
    const resolvedOptions: MoodleClientCoreOptions = typeof options === "string"
      ? { cookie: { name: "MoodleSession", value: options } }
      : options;
    super(baseUrl, { ...resolvedOptions, errorAdapter: NODE_ERROR_ADAPTER });
  }

  /** Reads local files, then uploads them into the assignment. Only the Node client has a filesystem. */
  async submitAssignmentFiles(request: SubmitLocalFilesRequest): Promise<SubmissionReceipt> {
    const { files, cwd, ...rest } = request;
    return this.submitAssignment({ ...rest, files: await readSubmissionFiles(files, cwd) });
  }
}

export async function createMoodleClient(
  baseUrl: string,
  options: AuthOptions & SessionCacheOptions & { noCache?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<MoodleClient> {
  const cacheOptions: SessionCacheOptions = {
    homeDir: options.homeDir,
    now: options.now,
    ttlMs: options.ttlMs,
    noCache: options.noCache,
    encryptionKey: options.encryptionKey,
  };
  const authOptions = { ...options, fetch: options.fetch ?? options.fetchImpl };
  const persistence = persistenceCallbacks(baseUrl, cacheOptions);
  const onLoginRequired = async () => authToClientSession(await getAuthenticatedSession(baseUrl, authOptions));

  if (!options.noCache) {
    const cached = await readCachedSession(baseUrl, cacheOptions);
    if (cached) {
      return new MoodleClient(baseUrl, {
        fetchImpl: options.fetchImpl,
        cookie: { name: cached.cookieName, value: cached.cookieValue },
        sesskey: cached.sesskey,
        userid: cached.userid,
        userInfo: cached.user,
        unavailable: cached.unavailable,
        ...persistence,
        onLoginRequired,
      });
    }
  }

  // A stale cache still knows which services the site disables and, for the same
  // account, the dashboard profile; a fresh sign-in should not relearn either.
  // Read it before signing in, because sign-in overwrites the cache file.
  const stale = options.noCache ? null : await readCachedSession(baseUrl, { ...cacheOptions, allowExpired: true }).catch(() => null);
  const session = authToClientSession(await getAuthenticatedSession(baseUrl, authOptions));
  return new MoodleClient(baseUrl, {
    fetchImpl: options.fetchImpl,
    cookie: session.cookie,
    pageContext: stale?.user && stale.userid === session.pageContext.user_info.userid
      ? { ...session.pageContext, user_info: stale.user }
      : session.pageContext,
    unavailable: stale?.unavailable,
    ...persistence,
    onLoginRequired,
  });
}

function persistenceCallbacks(
  baseUrl: string,
  options: SessionCacheOptions,
): Pick<MoodleClientCoreOptions, "clearSessionCache" | "writeSessionCache"> {
  return {
    clearSessionCache: async () => {
      const cached = await readCachedSession(baseUrl, { ...options, allowExpired: true });
      if (cached) await writeCachedSession({ ...cached, cookieInvalidated: true }, options);
    },
    writeSessionCache: async (session) => {
      const previous = await readCachedSession(baseUrl, { ...options, allowExpired: true });
      await writeCachedSession({
        ...session,
        // Client snapshots contain cookie state only. Keep renewal credentials
        // for the same account without carrying them across an account switch.
        ...(previous?.userid === session.userid ? { mobileToken: previous.mobileToken } : {}),
        mobileServiceEnabled: previous?.mobileServiceEnabled,
        savedAt: (options.now ?? Date.now)(),
      }, options);
    },
  };
}

function authToClientSession(
  auth: AuthenticatedSession,
): { cookie: MoodleSessionCookie; pageContext: PageContext } {
  return {
    cookie: auth.cookie,
    pageContext: {
      sesskey: auth.sesskey,
      user_info: {
        userid: auth.userid,
        username: "",
        fullname: "",
        sitename: "",
        siteurl: auth.baseUrl,
        lang: "",
      },
    },
  };
}
