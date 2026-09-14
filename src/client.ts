import { getAuthenticatedSession, type AuthOptions, type AuthenticatedSession } from "./auth.js";
import {
  MoodleClientCore,
  type MoodleClientCoreOptions,
  type MoodleClientErrorAdapter,
  type MoodleSessionCookie,
} from "./moodle-client-core.js";
import { isLoginRequiredError, MoodleAPIError, NotFoundError } from "./errors.js";
import type { PageContext } from "./models.js";
import {
  deleteCachedSession,
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
        ...persistence,
        onLoginRequired,
      });
    }
  }

  const session = authToClientSession(await getAuthenticatedSession(baseUrl, authOptions));
  return new MoodleClient(baseUrl, {
    fetchImpl: options.fetchImpl,
    cookie: session.cookie,
    pageContext: session.pageContext,
    ...persistence,
    onLoginRequired,
  });
}

function persistenceCallbacks(
  baseUrl: string,
  options: SessionCacheOptions,
): Pick<MoodleClientCoreOptions, "clearSessionCache" | "writeSessionCache"> {
  return {
    clearSessionCache: () => deleteCachedSession(baseUrl, options),
    writeSessionCache: (session) => writeCachedSession({
      ...session,
      savedAt: (options.now ?? Date.now)(),
    }, options),
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
