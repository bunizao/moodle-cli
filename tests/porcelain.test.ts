import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { siteUser, units, sections } from "./fixtures/intent-site.js";

const calls: string[] = [];
function fixtureFetch(label: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/my/") return new Response('<html><script>M.cfg={"sesskey":"fixture","userid":7}</script><span class="userfullname">Alex</span></html>');
    if (url.pathname.includes("/pluginfile.php/")) return new Response("slides", { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="slides.pdf"' } });
    if (url.pathname === "/mod/resource/view.php") return new Response('<html><h1>Slides</h1><div class="resourceworkaround"><a href="/pluginfile.php/1/slides.pdf">slides.pdf</a></div></html>', { headers: { "content-type": "text/html" } });
    if (url.pathname === "/lib/ajax/service.php") {
      const batch = JSON.parse(String(init?.body)) as { methodname: string; args: Record<string, number> }[];
      calls.push(...batch.map(c => c.methodname));
      return Response.json(batch.map(c => {
        let data: unknown;
        switch (c.methodname) {
          case "core_webservice_get_site_info": data = siteUser; break;
          case "core_enrol_get_users_courses": data = units; break;
          case "core_course_get_contents": data = sections(label, c.args.courseid).map(s => ({ ...s, modules: s.activities })); break;
          case "core_calendar_get_action_events_by_timesort": data = { events: [] }; break;
          case "core_course_get_course_module": data = { cm: { id: c.args.cmid, course: 2, modname: "resource" } }; break;
          case "mod_forum_get_forums_by_courses": data = []; break;
          default: data = {};
        }
        return { error: false, data };
      }));
    }
    throw new Error(`Unexpected fixture path ${url.pathname}`);
  };
}
async function command(args: string[], options: { label?: string; tty?: boolean; directory?: string } = {}) {
  calls.length = 0;
  const home = await mkdtemp(join(tmpdir(), "moodle-porcelain-"));
  let stdout = "", stderr = "";
  try {
    const code = await runCli(["node", "moodle", ...args, "--no-cache"], {
      env: { MOODLE_BASE_URL: siteUser.siteurl, MOODLE_SESSION: "fixture" }, homeDir: home, cwd: options.directory ?? home,
      fetchImpl: fixtureFetch(options.label ?? "Week"), stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: { isTTY: options.tty ?? false, write: (value: string) => { stdout += value; return true; } } as NodeJS.WriteStream,
      stderr: { write: (value: string) => { stderr += value; return true; } },
    });
    return { code, stdout, stderr };
  } finally { await rm(home, { recursive: true, force: true }); }
}

describe("porcelain through the real Commander and HTTP boundary", () => {
  it.each(["Week", "Topic", "Semana"])("finds section 7 in %s-labelled units", async label => {
    for (const ref of ["algo-2", "Ethics in Computing", "Databases"]) {
      const result = await command([ref, "7"], { label });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ sections: [{ name: `${label} 7` }], total: 1 });
      expect(result.stdout).not.toContain(`${label} 17`);
      expect(result.stdout.trim()).not.toContain("\n");
    }
  });
  it("starts at home and reports ambiguity without prompting on JSON output", async () => {
    expect(JSON.parse((await command([])).stdout)).toMatchObject({ home: { timezone: "Europe/Berlin", today: expect.any(String) } });
    const qualified = await command(["algo-2", "week 7 mini test", "--json"]);
    expect(qualified.code, qualified.stderr).toBe(0);
    expect(JSON.parse(qualified.stdout)).toHaveProperty("item.id", 201);
    const result = await command(["algo-2", "mini test", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "ambiguous", candidates: [{ id: 201 }, { id: 211 }] } });
  });
  it("shares unit index output with the plumbing and treats unknown nouns as searches", async () => {
    const porcelain = await command(["algo-2"]);
    const plumbing = await command(["units", "show", "algo-2"]);
    expect(JSON.parse(porcelain.stdout)).toEqual(JSON.parse(plumbing.stdout));
    const query = await command(["week 7 slides"]);
    expect(query.code).toBe(0);
    expect(JSON.parse(query.stdout).total).toBe(4);
  });
  it("downloads a named resource to --to without needing an id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moodle-get-"));
    try {
      const result = await command(["get", "algo-2 week 7 slides", "--to", directory]);
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(join(directory, "slides.pdf"), "utf8")).toBe("slides");
      expect(JSON.parse(result.stdout).bytes_written).toBe(6);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("applies --limit after the command name and counts the unit list once", async () => {
    // Commander gives a flag declared on both the program and a subcommand to the
    // program, so the value has to be read from there as well.
    const limited = await command(["find", "week", "--limit", "1"]);
    expect(limited.code, limited.stderr).toBe(0);
    expect(JSON.parse(limited.stdout).results).toHaveLength(1);
    expect(JSON.parse((await command(["--limit", "1", "find", "week"])).stdout).results).toHaveLength(1);
    expect(calls.filter(name => name === "core_enrol_get_users_courses")).toHaveLength(1);
  });
  it("reports an unmatched target instead of an empty search", async () => {
    const result = await command(["zzz-no-such-unit"]);
    expect(result.code).toBe(4);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("algo-2");
    expect(error.candidates).toHaveLength(units.length);
  });
  it("honors explicit pretty formatting and concise human errors", async () => {
    const pretty = await command(["units", "--pretty"]);
    expect(pretty.stdout).toContain('\n  "units"');
    const human = await command(["unit"], { tty: true });
    expect(human.stderr.trim().split("\n")).toHaveLength(2);
    expect(human.stderr).toContain("Did you mean");
    expect((await command(["algo-2", "7", "--table"])).stdout).toContain("Try  ");
  });
});
