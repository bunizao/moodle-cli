import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { runCli } = await import(pathToFileURL(resolve(process.argv[2])).href);
const homeDir = await mkdtemp(join(tmpdir(), "moodle-packed-output-"));
const user = { userid: 101, fullname: "Package Smoke User", username: "package-smoke", sitename: "Synthetic Moodle", siteurl: "https://moodle.example", lang: "en" };
try {
  for (const format of ["--table", "--json"]) {
    let output = "";
    let errors = "";
    const code = await runCli(["node", "moodle", "--no-cache", "user", format], {
      homeDir,
      cwd: homeDir,
      env: { MOODLE_BASE_URL: user.siteurl, MOODLE_SESSION: "synthetic-package-session" },
      stdout: { write: (chunk) => { output += chunk; return true; } },
      stderr: { write: (chunk) => { errors += chunk; return true; } },
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, user.siteurl);
        if (url.pathname === "/my/") {
          return new Response('<html><script>M.cfg={"sesskey":"synthetic-sesskey","userid":101}</script></html>', { headers: { "content-type": "text/html" } });
        }
        assert.equal(url.pathname, "/lib/ajax/service.php");
        const calls = JSON.parse(init.body);
        assert.ok(calls.every((call) => call.methodname === "core_webservice_get_site_info"));
        return Response.json(calls.map((_, index) => ({ index, error: false, data: user })));
      },
    });
    assert.equal(code, 0, errors);
    assert.equal(errors, "");
    if (format === "--table") {
      assert.match(output, /Package Smoke User/);
      assert.match(output, /┌/);
    } else {
      assert.equal(JSON.parse(output).user.id, user.userid);
    }
  }
  console.log("Installed CLI table and JSON output passed");
} finally {
  await rm(homeDir, { recursive: true, force: true });
}
