import type { EmbeddedMedia } from "./models.js";
import type { MoodleSessionCookie } from "./auth.js";
import { isSiteUrl } from "./site-root.js";

// Matches the Moodle transport's budget; external hosts get no longer to stall.
const CAPTION_TIMEOUT_MS = 30_000;

export async function fetchMediaCaptions(
  media: EmbeddedMedia,
  moodleBaseUrl: string,
  requestMoodle: (url: string) => Promise<Response>,
  browserCookies: (url: string) => Promise<MoodleSessionCookie[]>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const source = new URL(media.url);
  const panopto = /\/Panopto\/Pages\/Viewer\.aspx$/iu.test(source.pathname) && media.id;
  if (panopto) {
    if (source.protocol !== "https:") throw new Error("Panopto captions require an HTTPS video URL.");
    const url = new URL("/Panopto/Pages/Transcription/GenerateSRT.ashx", source.origin);
    url.searchParams.set("id", media.id!);
    const cookies = await browserCookies(source.origin);
    const profiles = new Map<string, MoodleSessionCookie[]>();
    for (const cookie of cookies) {
      const source = cookie.source ?? "browser";
      profiles.set(source, [...(profiles.get(source) ?? []), cookie]);
    }
    for (const profile of profiles.values()) {
      if (!profile.some(cookie => cookie.name.toLowerCase() === ".aspxauth")) continue;
      const cookie = profile.map(({ name, value }) => `${name}=${value}`).join("; ");
      const response = await fetchImpl(url, { headers: { Cookie: cookie }, redirect: "manual", signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS) });
      const text = await captionBody(response);
      if (text) return text;
    }
    throw new Error("Panopto did not return captions. Sign in to Panopto in your browser and check that this recording has captions.");
  }

  const caption = media.captions?.[0];
  if (!caption) throw new Error("This video has no caption track exposed by Moodle.");
  const url = new URL(caption.url);
  // Only a track inside this install gets the Moodle session; a sibling path on the same host does not.
  const response = isSiteUrl(moodleBaseUrl, url)
    ? await requestMoodle(url.toString())
    : await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS) });
  const text = await captionBody(response);
  if (!text) throw new Error("The caption track returned no timestamped text.");
  return text;
}

async function captionBody(response: Response): Promise<string> {
  if (!response.ok || response.redirected || response.status >= 300) return "";
  if (Number(response.headers.get("content-length")) > 10_000_000) return "";
  const text = (await response.text()).replace(/^\uFEFF/u, "");
  if (text.length > 10_000_000) return "";
  return /^\s*WEBVTT\b/u.test(text) || /^\s*\d+\s*\r?\n\d\d:\d\d:\d\d,\d\d\d\s*-->/mu.test(text) ? text.trim() : "";
}
