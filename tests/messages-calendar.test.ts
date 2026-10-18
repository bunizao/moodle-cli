import { describe, expect, it, vi } from "vitest";
import { MoodleClient } from "../src/client.js";
import { createMoodleGateway } from "../src/mcp/gateway.js";
import { createMoodleMcpServer, TOOL_CATALOG } from "../src/mcp/server.js";
import { runCli } from "../src/cli.js";

const baseUrl = "https://moodle.example.edu";
const user = { userid: 7, username: "student", fullname: "A Student", sitename: "Moodle", siteurl: baseUrl };
function clientWith(handler: (name: string, args: Record<string, unknown>) => unknown) {
  const requests: Array<{ methodname: string; args: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const calls = JSON.parse(String(init?.body)) as typeof requests;
    requests.push(...calls);
    return Response.json(calls.map((call, index) => ({ index, error: false, data: handler(call.methodname, call.args) })));
  });
  const client = new MoodleClient(baseUrl, { cookie: { name: "MoodleSession", value: "test" }, sesskey: "test", userid: 7, userInfo: user, fetchImpl });
  return { client, requests, fetchImpl };
}
const member = { id: 8, fullname: "Teacher" };
const message = { id: 90, useridfrom: 8, text: "<p>Reminder</p>", timecreated: 100 };

describe("messages through MoodleClient and MCP", () => {
  it("lists direct and group conversations and reads messages without changing unread state", async () => {
    const { client, requests } = clientWith(name => name === "core_message_get_conversations"
      ? { conversations: [{ id: 1, type: 1, unreadcount: 2, members: [member], messages: [message] }, { id: 2, name: "Team Alpha chat", type: 2, unreadcount: 1, members: [member], messages: [] }] }
      : { id: 2, members: [member], messages: [{ ...message, id: 91, timecreated: 200 }, message] });
    expect(await client.getConversations()).toMatchObject([{ id: 1, name: "Teacher", type: "direct", unread_count: 2 }, { id: 2, name: "Team Alpha chat", type: "group" }]);
    expect(await client.getConversation(2, 20, 5)).toMatchObject({ id: 2, messages: [{ id: 90, text: "Reminder" }, { id: 91 }], offset: 5 });
    expect(requests.map(r => r.methodname)).toEqual(["core_message_get_conversations", "core_message_get_conversation_messages"]);
    expect(requests[1].args).toMatchObject({ currentuserid: 7, convid: 2, limitnum: 20, limitfrom: 5, newest: true });
  });
  it("sends to both conversation and user targets and propagates a rejected instant message", async () => {
    const { client, requests } = clientWith((_name, args) => args.messages && (args.messages as Array<{ touserid: number }>)[0].touserid === 9 ? [{ msgid: -1, errormessage: "User is blocked" }] : [{ id: 101, msgid: 101 }]);
    await expect(client.sendMessage(2, "Reply")).resolves.toEqual({ id: 101 });
    await expect(client.sendMessage(8, "Hello", { user: true })).resolves.toEqual({ id: 101 });
    await expect(client.sendMessage(9, "Hello", { user: true })).rejects.toThrow("User is blocked");
    expect(requests[0]).toMatchObject({ methodname: "core_message_send_messages_to_conversation", args: { conversationid: 2, messages: [{ text: "Reply", textformat: 2 }] } });
    expect(requests[1]).toMatchObject({ methodname: "core_message_send_instant_messages", args: { messages: [{ touserid: 8, text: "Hello", textformat: 2 }] } });
  });
  it("marks every unread conversation, including pages after the first hundred", async () => {
    const { client, requests } = clientWith((name, args) => name === "core_message_get_conversations" ? { conversations: args.limitfrom === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, unreadcount: i === 0 ? 1 : 0 })) : [{ id: 101, unreadcount: 2 }] } : {});
    await expect(client.markMessagesRead()).resolves.toEqual({ conversations: [1, 101] });
    expect(requests.filter(r => r.methodname === "core_message_mark_all_conversation_messages_as_read").map(r => r.args)).toEqual([{ userid: 7, conversationid: 1 }, { userid: 7, conversationid: 101 }]);
  });
  it("returns empty conversations through MCP without failing the compact output schema", async () => {
    const { client } = clientWith(name => name === "core_message_get_conversations"
      ? { conversations: [{ id: 1, type: 3, members: [], messages: [], unreadcount: 0 }] }
      : { id: 1, members: [], messages: [] });
    const server = createMoodleMcpServer(createMoodleGateway(client));
    for (const [name, args] of [["messages", {}], ["conversation", { conversation_id: 1 }]] as const) {
      const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { protocolVersion: "2025-06-18" });
      expect(response).toHaveProperty("result.structuredContent");
      expect(response).not.toHaveProperty("result.isError");
    }
  });
  it("exposes only messaging reads on the hosted MCP gateway", async () => {
    const { client, requests } = clientWith(name => name === "core_message_get_conversations" ? { conversations: [{ id: 2, name: "Team Alpha chat", type: 2, unreadcount: 1, members: [member], messages: [message] }] } : { id: 2, members: [member], messages: [message] });
    const server = createMoodleMcpServer(createMoodleGateway(client));
    const call = (name: string, args = {}) => server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { protocolVersion: "2025-06-18" });
    expect(await call("messages")).toMatchObject({ result: { structuredContent: { conversations: [{ id: 2, type: "group" }], returned: 1 } } });
    expect(await call("conversation", { conversation_id: 2 })).toMatchObject({ result: { structuredContent: { conversation: { id: 2, messages: [{ text: "Reminder" }] } } } });
    expect(await call("messages_send")).toMatchObject({ error: { code: -32602 } });
    expect(requests.every(r => !r.methodname.includes("send") && !r.methodname.includes("mark"))).toBe(true);
    expect(TOOL_CATALOG.filter(t => ["messages", "conversation", "calendar"].includes(t.name)).every(t => t.annotations.readOnlyHint)).toBe(true);
  });
});

describe("notifications through MoodleClient", () => {
  it("returns notification body and link and marks one or all as read", async () => {
    const { client, requests } = clientWith(name => name === "message_popup_get_popup_notifications"
      ? { notifications: [{ id: 14, subject: "New feedback", fullmessagehtml: "<p>Your feedback is ready.</p>", contexturl: `${baseUrl}/mod/assign/view.php?id=5`, read: false }] }
      : true);
    expect((await client.getAlerts()).notifications[0]).toMatchObject({ body: "Your feedback is ready.", context_url: `${baseUrl}/mod/assign/view.php?id=5` });
    await client.markAlertsRead(14);
    await client.markAlertsRead();
    expect(requests.slice(-2)).toEqual([
      expect.objectContaining({ methodname: "core_message_mark_notification_read", args: { notificationid: 14 } }),
      expect.objectContaining({ methodname: "core_message_mark_all_notifications_as_read", args: { useridto: 7 } }),
    ]);
  });
});

describe("profile timezone through CLI and MCP", () => {
  it("keeps the Moodle timezone in message and calendar results and human output", async () => {
    const at = Date.parse("2026-10-18T12:00:00Z") / 1000;
    const fetchImpl: typeof fetch = async (_url, init) => init?.method === "POST"
      ? Response.json((JSON.parse(String(init.body)) as Array<{ methodname: string }>).map(({ methodname }, index) => ({ index, error: false, data:
        methodname === "core_webservice_get_site_info" ? { ...user, timezone: "Pacific/Auckland" }
        : methodname === "core_message_get_conversations" ? { conversations: [] }
        : methodname === "core_message_get_conversation_messages" ? { id: 2, members: [member], messages: [{ ...message, timecreated: at }] }
        : { weeks: [{ days: [{ events: [{ id: 5, name: "Dentist", timestart: at }] }] }] },
      })))
      : new Response('<script>M.cfg = {"sesskey":"test","userid":7};</script><body id="page-my-index"></body>');
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T11:00:00Z"));
    try {
      for (const args of [["messages", "show", "2"], ["calendar"]]) {
        let output = "";
        expect(await runCli(["node", "moodle", ...args, "--table"], { env: { MOODLE_BASE_URL: baseUrl, MOODLE_SESSION: "test" }, fetchImpl, stdout: { write: (text: string) => { output += text; return true; } }, stderr: { write: () => true } })).toBe(0);
        expect(output).toContain("Mon 19 Oct, 01:00");
      }
      const client = new MoodleClient(baseUrl, { cookie: { name: "MoodleSession", value: "test" }, sesskey: "test", userid: 7, fetchImpl });
      const server = createMoodleMcpServer(createMoodleGateway(client));
      for (const [name, args] of [["messages", {}], ["conversation", { conversation_id: 2 }], ["calendar", {}]] as const) {
        expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { protocolVersion: "2025-06-18" })).toMatchObject({ result: { structuredContent: { timezone: "Pacific/Auckland" } } });
      }
    } finally { vi.useRealTimers(); }
  });
});

describe("calendar through MoodleClient and CLI", () => {
  it("reads all calendar kinds across month boundaries, filters the window and deduplicates spanning events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    try {
      const start = Date.parse("2026-10-31T12:00:00Z") / 1000;
      const event = (id: number, name: string, eventtype: string, courseid = 0, timestart = start) => ({ id, name, eventtype, course: { id: courseid, shortname: courseid ? "UNIT1001" : "" }, timestart, timeduration: 3600 });
      const { client, requests } = clientWith(() => ({ weeks: [{ days: [{ events: [event(1, "Guest lecture", "course", 10), event(2, "Dentist", "user"), event(3, "Public holiday", "site", 1), event(4, "BBB session", "course", 10), event(1, "Guest lecture", "course", 10), event(5, "Later", "user", 0, start + 86400 * 30)] }] }] }));
      expect((await client.getCalendar(5)).map(e => e.name)).toEqual(["Guest lecture", "Dentist", "Public holiday", "BBB session"]);
      expect(requests.map(r => r.args.month)).toEqual([10, 11]);
      expect((await client.getCalendar(5, 10)).map(e => e.name)).toEqual(["Guest lecture", "BBB session"]);
      await expect(client.getCalendar(366)).rejects.toMatchObject({ code: "usage" });
    } finally { vi.useRealTimers(); }
  });
  it("merges non-action calendar events into overview and exposes the same events over read-only MCP", async () => {
    const starts = Math.floor(Date.now() / 1000) + 3600;
    const { client } = clientWith(name => name === "core_calendar_get_calendar_monthly_view"
      ? { weeks: [{ days: [{ events: [{ id: 5, name: "Dentist", eventtype: "user", timestart: starts }] }] }] }
      : name === "core_enrol_get_users_courses" ? [] : {});
    expect(await client.getOverview()).toMatchObject({ calendar: [{ id: 5, name: "Dentist" }], errors: [] });
    const server = createMoodleMcpServer(createMoodleGateway(client));
    expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "calendar", arguments: { days: 7 } } }, { protocolVersion: "2025-06-18" })).toMatchObject({ result: { structuredContent: { events: [{ id: 5, name: "Dentist", event_type: "user" }], total: 1 } } });
  });
  it("plans message writes without authenticating or changing Moodle", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("Dry runs must not call Moodle"); });
    for (const args of [["messages", "send", "user:8", "Hello"], ["messages", "read", "--all"], ["alerts", "read", "--all"]]) {
      let output = "";
      expect(await runCli(["node", "moodle", ...args, "--dry-run", "--json"], { fetchImpl, env: { MOODLE_BASE_URL: baseUrl }, stdout: { write: (text: string) => { output += text; return true; } }, stderr: { write: () => true } })).toBe(0);
      expect(JSON.parse(output)).toHaveProperty("planned");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("honours the requested CLI calendar window when Commander consumes --days globally", async () => {
    const now = Math.floor(Date.now() / 1000);
    let output = "";
    const fetchImpl: typeof fetch = async (_url, init) => init?.method === "POST"
      ? Response.json((JSON.parse(String(init.body)) as Array<{ methodname: string }>).map((_, index) => ({ index, error: false, data: { weeks: [{ days: [{ events: [{ id: 1, name: "Tomorrow", timestart: now + 86400 }, { id: 2, name: "Next week", timestart: now + 86400 * 7 }] }] }] } })))
      : new Response('<script>M.cfg = {"sesskey":"test","userid":7};</script><body id="page-my-index"></body>');
    expect(await runCli(["node", "moodle", "calendar", "--days", "2", "--json"], { env: { MOODLE_BASE_URL: baseUrl, MOODLE_SESSION: "test" }, fetchImpl, stdout: { write: (text: string) => { output += text; return true; } }, stderr: { write: () => true } })).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ events: [{ id: 1, name: "Tomorrow" }], total: 1 });
  });
  it("prints an importable iCalendar stream with escaped text and folded UTF-8 lines", async () => {
    const at = Math.floor(Date.now() / 1000) + 3600;
    const fixture = { weeks: [{ days: [{ events: [{ id: 42, name: "Dentist; check, " + "界".repeat(50), description: "<p>Bring ID</p>", eventtype: "user", timestart: at, timeduration: 3600 }] }] }] };
    let output = "";
    const fetchImpl: typeof fetch = async (_url, init) => init?.method === "POST"
      ? Response.json((JSON.parse(String(init.body)) as Array<{ methodname: string }>).map((_, index) => ({ index, error: false, data: fixture })))
      : new Response('<script>M.cfg = {"sesskey":"test","userid":7};</script><body id="page-my-index"></body>');
    const result = await runCli(["node", "moodle", "calendar", "--ics"], { env: { MOODLE_BASE_URL: baseUrl, MOODLE_SESSION: "test" }, fetchImpl, stdout: { write: (text: string) => { output += text; return true; } }, stderr: { write: () => true } });
    expect(result).toBe(0);
    expect(output).toContain("BEGIN:VCALENDAR\r\n");
    expect(output).toContain("SUMMARY:Dentist\\; check\\,");
    expect(output).toContain("UID:42@moodle.example.edu");
    expect(output).toContain("DTEND:");
    expect(output.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(output.split("\r\n").every(line => new TextEncoder().encode(line).length <= 75)).toBe(true);
  });
});
