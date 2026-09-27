import { describe, expect, it, vi } from "vitest";

import { BACK, type Ui } from "@bunizao/cli-kit";

import type { MoodleClient } from "../src/client.js";
import { chooseDownloadSource } from "../src/download-source.js";
import { createIntentService } from "../src/intents.js";
import type { MoodleGateway } from "../src/mcp/gateway.js";
import { fixtureSections, fixtureUnits } from "./resolve.test.js";

const BASE_URL = "https://moodle.example.edu";

function setup() {
  // The section page repeats the flat list's items; the browser reads it for the last step.
  const page = `<li id="section-2" class="section course-section main" data-for="section" data-id="71" data-number="2"><h3 class="sectionname">Week 17</h3><ul class="section">${fixtureSections()[1].activities.map(a =>
    `<li class="activity activity-wrapper ${a.modname} modtype_${a.modname}" id="module-${a.id}" data-for="cmitem" data-id="${a.id}"><div class="activityname"><a href="${BASE_URL}/mod/${a.modname}/view.php?id=${a.id}"><span class="instancename">${a.name}</span></a></div></li>`).join("")}</ul></li>`;
  const client = {
    baseUrl: BASE_URL,
    getCourses: async () => fixtureUnits,
    requestAbsolute: async () => new Response(page, { headers: { "content-type": "text/html" } }),
  } as unknown as MoodleClient;
  const gateway = {
    listCourses: async () => fixtureUnits,
    getCourse: async () => ({ sections: fixtureSections() }),
  } as unknown as MoodleGateway;
  return { client, service: createIntentService(gateway) };
}

describe("download source choice", () => {
  it("passes ids and URLs through untouched", async () => {
    const { client, service } = setup();
    await expect(chooseDownloadSource(client, service, " 42 ")).resolves.toBe("42");
    await expect(chooseDownloadSource(client, service, `${BASE_URL}/mod/assign/view.php?id=5`)).resolves.toBe(`${BASE_URL}/mod/assign/view.php?id=5`);
  });

  it("reads a phrase naming a section as the whole section, and a narrower one as the item", async () => {
    const { client, service } = setup();
    await expect(chooseDownloadSource(client, service, "algo-2 week 7")).resolves.toBe(`${BASE_URL}/course/view.php?id=2&section=1`);
    await expect(chooseDownloadSource(client, service, "algo-2 week 7 slides")).resolves.toBe("100");
  });

  it("errors with choices instead of prompting when nobody is at a terminal", async () => {
    const { client, service } = setup();
    await expect(chooseDownloadSource(client, service, "")).rejects.toMatchObject({ code: "usage" });
    await expect(chooseDownloadSource(client, service, "algo-2")).rejects.toMatchObject({ code: "usage" });
    await expect(chooseDownloadSource(client, service, "algo-2 mini test")).rejects.toMatchObject({ code: "ambiguous" });
  });

  it("browses unit, section, then item, and Escape steps back with the last choice highlighted", async () => {
    const { client, service } = setup();
    const pick = (label: string) => async (_message: string, choices: Array<{ label: string; value: unknown }>) => choices.find(c => c.label.includes(label))!.value;
    const warn = vi.fn();
    const select = vi.fn()
      .mockImplementationOnce(pick("Algorithms"))
      .mockResolvedValueOnce(BACK)
      .mockImplementationOnce(pick("Algorithms"))
      .mockImplementationOnce(pick("Week 7"))
      .mockImplementationOnce(pick("Week 17"))
      .mockResolvedValueOnce(BACK)
      .mockImplementationOnce(pick("Week 17"))
      .mockImplementationOnce(pick("Everything"));
    const ui = { select, warn } as unknown as Ui;
    await expect(chooseDownloadSource(client, service, "", ui)).resolves.toBe(`${BASE_URL}/course/view.php?id=2&section=2`);

    const [unit, back, unitAgain, sections, , items, again, last] = select.mock.calls;
    expect(unit[2]).toMatchObject({ search: true });
    expect(back[0]).toBe("algo-2 › Section");
    expect(unitAgain[2]).toMatchObject({ initial: { shortname: "algo-2" } });
    expect(sections[1].map((c: { hint?: string }) => c.hint)).toEqual(["current", undefined]);
    expect(sections[2]).toMatchObject({ back: true, initial: 70 });
    // Week 7's page is missing from the fixture: a warning, and the section list again.
    expect(warn).toHaveBeenCalledWith("Week 7 has no files to download.");
    expect(items[0]).toBe("algo-2 › Week 17");
    expect(again[2]).toMatchObject({ initial: 71 });
    expect(last[0]).toBe("algo-2 › Week 17");
    expect(last[1].map((c: { label: string; hint: string }) => `${c.label} (${c.hint})`)).toEqual(["Everything in Week 17 (2 items)", "Week 17 Lecture slides (file)", "Mini Test (assignment)"]);
  });

  it("asks which unit when the leading words name several", async () => {
    const { client, service } = setup();
    const select = vi.fn(async (_message: string, choices: Array<{ label: string; value: unknown }>) => choices.find(c => c.label === "Algorithms")!.value);
    const ui = { select } as unknown as Ui;
    await expect(chooseDownloadSource(client, service, "s week 7", ui)).resolves.toBe(`${BASE_URL}/course/view.php?id=2&section=1`);
    expect(select.mock.calls[0][0]).toBe("'s' matches several units");
    await expect(chooseDownloadSource(client, service, "s week 7")).rejects.toMatchObject({ code: "ambiguous" });
  });
});
