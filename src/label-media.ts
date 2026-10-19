import { parse } from "node-html-parser";
import { cleanText } from "./html-utils.js";
import type { EmbeddedMedia } from "./models.js";

export interface LabelContent {
  media: EmbeddedMedia[];
  // Students only see availability info on a label Moodle withholds from them.
  restriction: string;
}

export function parseLabelMedia(html: string, activityId: number, baseUrl: string): LabelContent | null {
  const module = parse(html).querySelector(`#module-${activityId}`);
  if (!module) return null;

  const media = new Map<string, EmbeddedMedia>();
  for (const link of module.querySelectorAll("a[href]")) {
    const url = mediaUrl(link.getAttribute("href"), baseUrl);
    if (!url || !/\/Panopto\/Pages\/Viewer\.aspx$/iu.test(url.pathname)) continue;
    const id = url.searchParams.get("id");
    if (!id) continue;
    const canonical = new URL(url.pathname, url.origin);
    canonical.searchParams.set("id", id);
    media.set(`${url.origin}/${id}`, { id, title: cleanText(link.textContent) || cleanText(link.querySelector("img")?.getAttribute("alt")), url: canonical.toString() });
  }

  for (const iframe of module.querySelectorAll("iframe[src]")) {
    const url = mediaUrl(iframe.getAttribute("src"), baseUrl);
    if (!url) continue;
    const panopto = /\/Panopto\/Pages\/Embed\.aspx$/iu.test(url.pathname);
    const id = panopto ? url.searchParams.get("id") : null;
    const key = id ? `${url.origin}/${id}` : url.toString();
    const title = cleanText(iframe.getAttribute("title"));
    const existing = media.get(key);
    if (existing) {
      existing.title ||= title;
      continue;
    }
    const canonical = id ? new URL(`/Panopto/Pages/Viewer.aspx?id=${encodeURIComponent(id)}`, url.origin) : url;
    media.set(key, { ...(id ? { id } : {}), title, url: canonical.toString() });
  }

  for (const video of module.querySelectorAll("video")) {
    const url = mediaUrl(video.getAttribute("src") || video.querySelector("source[src]")?.getAttribute("src"), baseUrl);
    if (!url) continue;
    const captions = video.querySelectorAll("track[src]")
      .filter(track => ["captions", "subtitles"].includes(track.getAttribute("kind") ?? "captions"))
      .flatMap(track => {
        const captionUrl = mediaUrl(track.getAttribute("src"), baseUrl);
        return captionUrl ? [{ url: captionUrl.toString(), language: track.getAttribute("srclang") ?? undefined }] : [];
      });
    media.set(url.toString(), { title: cleanText(video.getAttribute("title")), url: url.toString(), ...(captions.length ? { captions } : {}) });
  }
  return {
    // An image-only link with no alt text still needs a title; the schema requires one.
    media: [...media.values()].map(item => ({ ...item, title: item.title || "Embedded video" })),
    restriction: cleanText(module.querySelector(".availabilityinfo")?.textContent),
  };
}

function mediaUrl(value: string | undefined, baseUrl: string): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    return ["https:", "http:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}
