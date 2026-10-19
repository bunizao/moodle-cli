import { describe, expect, it, vi } from "vitest";
import { fetchMediaCaptions } from "../src/media-captions.js";

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
