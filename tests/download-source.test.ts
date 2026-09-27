import { describe, expect, it, vi } from "vitest";

import type { Ui } from "@bunizao/cli-kit";

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

  it("browses unit, section, then item at a terminal", async () => {
    const { client, service } = setup();
    const select = vi.fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(71)
      .mockImplementationOnce(async (_message: string, choices: Array<{ value: string }>) => choices[0].value);
    const ui = { select } as unknown as Ui;
    await expect(chooseDownloadSource(client, service, "", ui)).resolves.toBe(`${BASE_URL}/course/view.php?id=2&section=2`);
    expect(select.mock.calls[2][1].map((c: { label: string }) => c.label)).toEqual(["Everything in this section", "Week 17 Lecture slides", "Mini Test"]);
  });
});
