/**
 * A Moodle site root is the install address Moodle calls `wwwroot`: an origin plus an
 * optional install path, such as https://host or https://host/elearning/moodle. It never
 * ends in a slash. Every "is this URL ours" check and every path join goes through here,
 * because comparing origins alone would treat a sibling install on the same host as ours,
 * and `new URL("/path", root)` silently drops the install path.
 */

/** The install path with no trailing slash: "" for a root install, "/moodle" otherwise. */
export function siteRootPath(root: string): string {
  return new URL(root).pathname.replace(/\/+$/u, "");
}

/** Join a site path such as "/lib/ajax/service.php" (query allowed) onto the site root. */
export function siteUrl(root: string, path: string): string {
  return `${root.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** True when `url` is the site root itself or a page inside it. */
export function isSiteUrl(root: string, url: string | URL): boolean {
  let site: URL;
  let target: URL;
  try {
    site = new URL(root);
    target = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  if (target.origin !== site.origin) return false;
  const base = siteRootPath(root);
  return target.pathname === base || target.pathname.startsWith(`${base}/`);
}

/** The path of `url` relative to the site root ("/mod/forum/view.php"), or null when it is not ours. */
export function sitePath(root: string, url: string | URL): string | null {
  if (!isSiteUrl(root, url)) return null;
  const target = typeof url === "string" ? new URL(url) : url;
  return target.pathname.slice(siteRootPath(root).length) || "/";
}

/** True when two site roots name the same install, ignoring a trailing slash and case in the host. */
export function sameSiteRoot(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && siteRootPath(left) === siteRootPath(right);
  } catch {
    return false;
  }
}

/** True when `url` is Moodle's sign-in area for this site: where it sends a lapsed session. */
export function isSiteLoginUrl(root: string, url: string | URL): boolean {
  return sitePath(root, url)?.startsWith("/login/") ?? false;
}
