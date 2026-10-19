import { describe, expect, it, vi } from "vitest";
import { fetchMediaCaptions } from "../src/media-captions.js";
import { parseLabelMedia } from "../src/label-media.js";

describe("Panopto caption export", () => {
  const media = { id: "recording-id", title: "Lecture", url: "https://video.panopto.com/Panopto/Pages/Viewer.aspx?id=recording-id" };
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";

  it("uses the signed-in browser cookie and accepts timestamped SRT", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe("https://video.panopto.com/Panopto/Pages/Transcription/GenerateSRT.ashx?id=recording-id");
      expect(init?.headers).toEqual({ Cookie: ".ASPXAUTH=valid" });
      expect(init?.redirect).toBe("manual");
      return new Response(srt, { status: 200 });
    });
    const text = await fetchMediaCaptions(media, "https://school.example.edu", vi.fn(), async () => [{ name: ".ASPXAUTH", value: "valid", source: "chrome:Default" }], fetchImpl as typeof fetch);
    expect(text).toBe(srt.trim());
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not treat an empty or sign-in response as captions", async () => {
    await expect(fetchMediaCaptions(media, "https://school.example.edu", vi.fn(), async () => [{ name: ".ASPXAUTH", value: "expired" }], async () => new Response("<html>Sign in</html>", { status: 200 })))
      .rejects.toThrow("Panopto did not return captions");
  });
});

describe("inline label media", () => {
  const base = "https://school.example.edu";

  it("takes the embed title when the viewer link is an image without alt text", () => {
    const html = '<li id="module-7"><a href="https://video.example.edu/Panopto/Pages/Viewer.aspx?id=v1"><img src="thumb.png"></a><iframe src="https://video.example.edu/Panopto/Pages/Embed.aspx?id=v1" title="Week 3 lecture"></iframe><a href="https://video.example.edu/Panopto/Pages/Viewer.aspx?id=v2"><img src="thumb.png"></a></li>';
    expect(parseLabelMedia(html, 7, base)?.media.map(item => item.title)).toEqual(["Week 3 lecture", "Embedded video"]);
  });

  it("reports the restriction Moodle shows instead of an empty label", () => {
    const html = '<li id="module-7"><div class="availabilityinfo">Not available unless: You belong to Group A</div></li>';
    expect(parseLabelMedia(html, 7, base)).toEqual({ media: [], restriction: "Not available unless: You belong to Group A" });
  });

  it("bounds caption requests to external hosts", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi", { status: 200 });
    });
    const video = { title: "Lecture", url: "https://cdn.example.org/v.mp4", captions: [{ url: "https://cdn.example.org/v.vtt" }] };
    await expect(fetchMediaCaptions(video, base, vi.fn(), vi.fn(), fetchImpl as typeof fetch)).resolves.toContain("WEBVTT");
  });
});
