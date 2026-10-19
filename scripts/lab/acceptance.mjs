#!/usr/bin/env node
// Exercises the built CLI against the disposable lab, including real student writes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const lab = resolve(process.env.MOODLE_LAB_DIR || join(homedir(), ".cache/moodle-cli-lab"));
const truth = JSON.parse(readFileSync(join(lab, "ground-truth.json"), "utf8"));
const site = new URL(truth.base_url);
assert(["127.0.0.1", "localhost", "[::1]"].includes(site.hostname), "Acceptance writes require a local disposable Moodle lab.");
const cli = resolve(process.env.MOODLE_LAB_CLI || fileURLToPath(new URL("../../dist/moodle.js", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "moodle-acceptance-"));
const env = {
  ...process.env,
  HOME: temporary,
  USERPROFILE: temporary,
  XDG_CONFIG_HOME: join(temporary, "config"),
  XDG_CACHE_HOME: join(temporary, "cache"),
  MOODLE_BASE_URL: site.origin,
  MOODLE_SESSION: readFileSync(join(lab, "session.txt"), "utf8").trim(),
  MOODLE_NO_UPDATE_CHECK: "1",
  NO_COLOR: "1",
};
const report = { checked_at: new Date().toISOString(), generated_at: truth.generated_at, moodle_release: truth.moodle_release, checks: [] };
const course = truth.courses.find(unit => unit.shortname === "LAB101");
const seeded = truth.v011;
assert(course && seeded, "Regenerate the lab with the v0.11 seed first.");
const activity = name => course.activities.find(item => item.name === name);
const marker = `CLI lab acceptance ${Date.now()}`;
const upload = join(temporary, "acceptance.txt");
writeFileSync(upload, "Disposable lab acceptance attachment.\n");

function command(args, { raw = false, exit = 0 } = {}) {
  const result = spawnSync(process.execPath, [cli, "--no-cache", "--yes", ...args.map(String), ...(raw ? [] : ["--json"])], {
    env, cwd: temporary, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, exit, `CLI ${args[0]} ${args[1] || ""} exited ${result.status}; expected ${exit}.`);
  const output = raw ? result.stdout : JSON.parse(exit ? result.stderr : result.stdout);
  return output;
}

function check(name, run) {
  try {
    run();
    report.checks.push({ name, status: "passed" });
    console.log(`PASS ${name}`);
  } catch (error) {
    // Store only our assertion messages, never command output or request credentials.
    const detail = error instanceof assert.AssertionError ? error.message.split("\n")[0] : "The check could not complete.";
    report.checks.push({ name, status: "failed", detail });
    console.log(`FAIL ${name}: ${detail}`);
  }
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

try {
  check("overdue actionable deadline", () => {
    const item = command(["due", course.id, "--days", 14, "--limit", 200]).due?.find(row => row.activity_id === seeded.overdue);
    assert(item, "The overdue assignment is absent.");
    assert.equal(item.status, "overdue");
    assert.equal(item.actionable, true);
  });
  check("manual grade and category total", () => {
    const grades = command(["grades", "list", course.id, "--mode", "all", "--include-feedback", "--limit", 200]).grades;
    const items = grades.flatMap(grade => grade.items || []);
    const midterm = items.find(item => item.name === "Midterm exam");
    assert(midterm, "The manual midterm grade is absent.");
    assert.equal(Number(midterm.grade), 78);
    assert.match(midterm.feedback, /Solid midterm/u);
    assert(items.some(item => /Exams/u.test(item.name)), "The Exams category total is absent.");
  });
  check("resource identity and unit", () => {
    const resource = activity("Lecture Slides");
    const item = command(["activities", "show", resource.cmid]).item;
    assert.equal(item.name, resource.name);
    assert.equal(item.unit_id, course.id);
  });
  check("restriction is readable", () => {
    const restricted = course.activities.find(item => item.visibility_for_student === "restricted");
    const item = command(["activities", "show", restricted.cmid]).item;
    assert.equal(item.available, false);
    assert(item.availability_reason, "The restriction reason is absent.");
    const listed = command(["activities", "list", course.id, "--limit", 200]).activities?.find(item => item.id === restricted.cmid);
    assert(listed?.availability_reason, "The activity list omits its restriction reason.");
  });
  check("manual completion and undo", () => {
    try {
      assert.equal(command(["complete", seeded.completion_page]).completion.completion, 1);
      assert.equal(command(["activities", "show", seeded.completion_page]).item.completion, 1);
    } finally {
      assert.equal(command(["complete", seeded.completion_page, "--undo"]).completion.completion, 0);
    }
    assert.equal(command(["activities", "show", seeded.completion_page]).item.completion, 0);
  });
  check("nested folder download", () => {
    const destination = join(temporary, "download");
    mkdirSync(destination);
    command(["download", activity("Readings").cmid, "--to", destination]);
    const paths = filesBelow(destination);
    for (const week of ["week-one", "week-two"]) {
      const path = paths.find(file => file.endsWith(join(week, "readme.txt")));
      assert(path, `The ${week} folder path was lost.`);
      assert.equal(readFileSync(path, "utf8"), `${week}\n`);
    }
  });
  check("messages list and read conversations", () => {
    const conversations = command(["messages", "list", "--limit", 200]).conversations || [];
    for (const id of [...seeded.conversations, seeded.team_chat]) assert(conversations.some(item => item.id === id), `Seeded conversation ${id} is absent.`);
    assert(conversations.some(item => item.name === "Team Alpha chat" && item.type === "group"));
    for (const id of seeded.conversations) assert(command(["messages", "show", id]).conversation.messages?.length, "Seeded messages are absent.");
  });
  check("messages send and mark read", () => {
    const id = seeded.conversations[0];
    const sent = command(["messages", "send", id, marker]).message;
    assert(sent.id > 0);
    assert(command(["messages", "show", id]).conversation.messages.some(message => message.id === sent.id && message.text === marker));
    command(["messages", "read", "--all"]);
    assert((command(["messages", "list", "--limit", 200]).conversations || []).every(item => item.unread_count === 0));
  });
  check("calendar includes user site course and BBB events", () => {
    const events = command(["calendar", "--days", 30]).events || [];
    for (const id of seeded.calendar_events) {
      const expected = truth.calendar_events.find(event => event.id === id);
      const actual = events.find(event => event.id === id);
      assert(expected && actual, `Calendar lacks ground-truth event ${id}.`);
      assert.equal(actual.name, expected.name);
      assert.equal(actual.starts_at, expected.timestart);
      assert.equal(actual.event_type, expected.eventtype);
      assert.equal(new URL(actual.url).hash, `#event_${id}`);
    }
    assert(events.some(event => event.name.includes("BBB study session")), "Calendar lacks the BBB session.");
    const overview = command(["overview", "--todo-days", 30]).home;
    assert(overview.calendar?.some(event => event.name.includes("Dentist")), "Overview omits calendar events.");
    const ics = command(["calendar", "--days", 30, "--ics"], { raw: true });
    assert.match(ics, /BEGIN:VCALENDAR/u);
    assert.match(ics, /SUMMARY:BBB study session/u);
    assert.match(ics, /END:VCALENDAR/u);
  });
  check("first draft-only save remains protected", () => {
    const refusal = command(["submit", seeded.reflection, "--text", "Draft preview."], { exit: 2 });
    assert.equal(refusal.error.code, "usage");
    assert.match(refusal.error.message, /does not show whether.*drafts/u);
  });
  report.checks.push({ name: "first draft-only submission", status: "known_limitation", detail: "Stock Moodle exposes no draft-setting evidence before the first save; draft-only requests are refused. Initial --final is verified separately." });
  check("online text with files finalises and round-trips paragraphs", () => {
    const textFile = join(temporary, "reflection.md");
    writeFileSync(textFile, "First paragraph.\n\nSecond paragraph.");
    const receipt = command(["submit", seeded.reflection, upload, "--text-file", textFile, "--final", "--accept-statement"]).submission;
    assert.equal(receipt.action, "submitted");
    assert.equal(receipt.submission_state, "submitted");
    assert.equal(receipt.text, "First paragraph.\nSecond paragraph.");
    assert(receipt.files.some(file => file.name === "acceptance.txt"));
    const shown = command(["submission", "show", seeded.reflection]).submission;
    assert.equal(shown.text, "First paragraph.\nSecond paragraph.");
    assert(shown.files.some(file => file.name === "acceptance.txt"));
  });
  check("initial file submission and group finalisation", () => {
    assert.equal(command(["submit", seeded.draft_essay, upload, "--final", "--accept-statement"]).submission.action, "submitted");
    const group = command(["submit", seeded.group_project, upload, "--final", "--accept-statement"]).submission;
    assert.equal(group.action, "submitted");
    assert.equal(group.group, "Team Alpha");
    assert(group.awaiting?.includes("Pat Peer"));
  });
  check("editable submission removal", () => {
    const id = activity("Essay One").cmid;
    command(["submit", id, upload, "--final", "--accept-statement"]);
    assert.equal(command(["submission", "remove", id]).submission.action, "removed");
    const shown = command(["submission", "show", id]).submission;
    assert(!shown.text && !shown.files?.length, "Removal left submission content behind.");
  });
  check("forum reply with attachment and parent", () => {
    const discussion = truth.forum_discussions.find(item => item.forum_cmid === seeded.forum);
    const reply = command(["threads", "reply", discussion.firstpost, marker, "--attach", upload]).post;
    const thread = command(["threads", "show", discussion.id, "--limit", 200]).thread;
    const posted = thread.posts.find(post => post.id === reply.id);
    assert.equal(posted.parent_id, discussion.firstpost);
    assert(posted.attachments?.some(file => file.name === "acceptance.txt"));
  });
  check("forum discussion and subscription", () => {
    const post = command(["forums", "post", seeded.forum, "--subject", marker, "--text", "Disposable lab discussion."]).post;
    assert.equal(command(["threads", "show", post.discussion_id]).thread.posts[0].id, post.id);
    assert.equal(command(["forums", "subscribe", seeded.forum]).subscribed, true);
    assert.equal(command(["forums", "unsubscribe", seeded.forum]).subscribed, false);
  });
  check("quiz timer and labelled formula fields", () => {
    const args = ["quiz", "show", seeded.formulas_attempt, seeded.formulas_quiz];
    const before = command(args).attempt;
    assert(before.time_left_s > 0 && before.ends_at, "The seeded quiz timer is absent or expired; regenerate the lab.");
    const question = before.questions.find(item => item.kind === "fields");
    assert(question?.fields.length > 1, "The real formulas question has no multi-field interface.");
    assert(question.fields.some(field => field.label), "Formula field labels are absent.");
    const values = question.fields.map(() => "1");
    const after = command(["quiz", "answer", seeded.formulas_attempt, seeded.formulas_quiz, question.number, ...values.flatMap(value => ["--value", value])]).attempt;
    assert(after.time_left_s <= before.time_left_s);
    // Moodle exposes remaining seconds, so HTTP Date plus its countdown can round across a second.
    assert(Math.abs(Date.parse(after.ends_at) - Date.parse(before.ends_at)) <= 2000, "Quiz deadline estimates drifted by more than two seconds.");
    assert(after.questions.find(item => item.number === question.number).fields.every(field => field.answer === "1"));
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
  writeFileSync(join(lab, "acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
const failures = report.checks.filter(check => check.status === "failed").length;
console.log(`${report.checks.length - failures - 1} passed; ${failures} failed; 1 known limitation. Report: ${join(lab, "acceptance-report.json")}`);
process.exitCode = failures ? 1 : 0;
