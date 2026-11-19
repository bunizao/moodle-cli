// Copied from @bunizao/cli-kit/site-icon (0.9.0). Import it from there once this repo is on cli-kit 0.9.
// Finds a website's own icon and returns it as a data: URI, so a page with a strict
// CSP (img-src data:) can show the service it signs in to without loading anything
// from that site. Runtime-neutral: it needs only fetch.

export interface SiteIconOptions {
  /** Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Per request; defaults to 3 seconds. */
  readonly timeoutMs?: number;
}

const MAX_HTML_BYTES = 512 * 1024;
const MAX_ICON_BYTES = 128 * 1024;
const FAILURE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { icon: Promise<string | undefined>; at: number }>();

/**
 * The site's icon as a data: URI, or undefined when it has none worth showing.
 * Prefers an SVG icon, then the largest declared one, then /favicon.ico. Results
 * are cached for the life of the isolate; failures are retried after 5 minutes.
 */
export function siteIcon(site: string | URL, options: SiteIconOptions = {}): Promise<string | undefined> {
  const origin = new URL(site).origin;
  const hit = cache.get(origin);
  if (hit) return hit.icon.then((icon) => icon ?? retry(origin, hit.at, options));
  return load(origin, options);
}

function retry(origin: string, at: number, options: SiteIconOptions): Promise<string | undefined> {
  return Date.now() - at < FAILURE_TTL_MS ? Promise.resolve(undefined) : load(origin, options);
}

function load(origin: string, options: SiteIconOptions): Promise<string | undefined> {
  const icon = findIcon(origin, options).catch(() => undefined);
  cache.set(origin, { icon, at: Date.now() });
  return icon;
}

async function findIcon(origin: string, options: SiteIconOptions): Promise<string | undefined> {
  const get = (url: string) =>
    (options.fetch ?? fetch)(url, { redirect: "follow", signal: AbortSignal.timeout(options.timeoutMs ?? 3000) });
  const page = await get(`${origin}/`).catch(() => undefined);
  const base = page?.url || `${origin}/`;
  // A home page that redirects to a single sign-on host shows that host's icon, not the site's.
  const own = page?.ok && new URL(base).origin === origin;
  const html = own ? await readCapped(page, MAX_HTML_BYTES).catch(() => undefined) : undefined;
  const candidates = [...(html ? iconLinks(new TextDecoder().decode(html), base) : []), `${origin}/favicon.ico`];
  for (const url of new Set(candidates)) {
    const response = await get(url).catch(() => undefined);
    if (!response?.ok) continue;
    const bytes = await readCapped(response, MAX_ICON_BYTES).catch(() => undefined);
    const type = bytes && sniff(bytes);
    if (type) return `data:${type};base64,${base64(bytes)}`;
  }
  return undefined;
}

/** `<link rel="…icon…">` hrefs, best first. */
export function iconLinks(html: string, base: string): string[] {
  const links: Array<{ href: string; score: number }> = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/giu)) {
    const rel = attribute(tag, "rel")?.toLowerCase().split(/\s+/u) ?? [];
    const href = attribute(tag, "href");
    // mask-icon is a single-colour stencil, not the logo people know.
    if (!href || rel.includes("mask-icon") || !rel.some((word) => word === "icon" || word === "apple-touch-icon")) continue;
    let url: string;
    try {
      url = new URL(href, base).href;
    } catch {
      continue;
    }
    if (!url.startsWith("https:") && !url.startsWith("http:")) continue;
    const svg = attribute(tag, "type") === "image/svg+xml" || /\.svg(?:[?#]|$)/iu.test(href);
    const size = rel.includes("apple-touch-icon") ? 180 : Math.max(0, ...(attribute(tag, "sizes")?.match(/\d+/gu) ?? []).map(Number));
    links.push({ href: url, score: svg ? 10_000 : size });
  }
  return links.sort((a, b) => b.score - a.score).map((link) => link.href);
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.replaceAll("&amp;", "&");
}

/** Image type from the bytes themselves; servers often send no or the wrong content-type. */
function sniff(bytes: Uint8Array): string | undefined {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/iu.test(head)) return "image/svg+xml";
  return undefined;
}

async function readCapped(response: Response, limit: number): Promise<Uint8Array | undefined> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel();
    return undefined;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength > limit ? undefined : bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
