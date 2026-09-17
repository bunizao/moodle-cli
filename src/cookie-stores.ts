import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CookieStore {
  browser: string;
  path: string;
  readable: boolean;
}

export interface CookieStoreOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
}

const CHROMIUM_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["Chrome", "Google/Chrome"],
  ["Edge", "Microsoft Edge"],
  ["Brave", "BraveSoftware/Brave-Browser"],
];

const CHROMIUM_FILES = ["Cookies", "Network/Cookies"];

const SAFARI_FILES = [
  "Library/Cookies/Cookies.binarycookies",
  "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
];

function probe(path: string, mode: number): Promise<boolean> {
  return access(path, mode).then(() => true, () => false);
}

/**
 * macOS denies readdir on a protected browser directory even when the store
 * files inside it can still be probed, so an empty listing must not be read as
 * "this browser has no profiles".
 */
async function chromiumProfiles(root: string): Promise<string[]> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const profiles = entries.filter((entry) => entry === "Default" || entry.startsWith("Profile "));
  return profiles.length ? profiles : ["Default"];
}

/**
 * Cookie stores that exist on disk, each marked with whether this process may
 * actually open it. Only macOS withholds read access from a store the user owns.
 */
export async function browserCookieStores(options: CookieStoreOptions = {}): Promise<CookieStore[]> {
  if ((options.platform ?? process.platform) !== "darwin") {
    return [];
  }
  const home = options.homeDir ?? homedir();
  const stores: CookieStore[] = [];
  const add = async (browser: string, path: string) => {
    if (await probe(path, constants.F_OK)) {
      stores.push({ browser, path, readable: await probe(path, constants.R_OK) });
    }
  };

  for (const [browser, directory] of CHROMIUM_ROOTS) {
    const root = join(home, "Library/Application Support", directory);
    for (const profile of await chromiumProfiles(root)) {
      for (const file of CHROMIUM_FILES) {
        await add(browser, join(root, profile, file));
      }
    }
  }

  const firefoxRoot = join(home, "Library/Application Support/Firefox/Profiles");
  for (const profile of await readdir(firefoxRoot).catch(() => [] as string[])) {
    await add("Firefox", join(firefoxRoot, profile, "cookies.sqlite"));
  }

  for (const file of SAFARI_FILES) {
    await add("Safari", join(home, file));
  }

  return stores;
}

/** Stores that exist but cannot be opened. Signing in again cannot fix these. */
export function unreadableCookieStores(stores: readonly CookieStore[]): CookieStore[] {
  return stores.filter((store) => !store.readable);
}

/**
 * True when every store on this machine is unreadable, so a fresh browser login
 * has nowhere to land that we could read it from. A single denied store is not
 * enough: Safari keeps its cookies behind Full Disk Access on every Mac, while
 * the browser the user actually signs in with may still be readable.
 */
export function cookieStoresBlocked(stores: readonly CookieStore[]): boolean {
  return stores.length > 0 && stores.every((store) => !store.readable);
}
