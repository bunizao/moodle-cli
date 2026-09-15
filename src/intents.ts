import type { Course, Overview } from "./models.js";
import type { MoodleGateway } from "./mcp/gateway.js";
import { intentContracts, type Intent } from "./intent-contract.js";
import { currentSection, ReferenceError, resolveSection, resolveUnit, searchSections, splitUnitPhrase, tokensMatch, type SearchMatch } from "./resolve.js";
import { activityRow, dueRow, isoTime, itemRow, postRow, stripEmpty, timezoneFor, unitRow } from "./results.js";

export function createIntentService(gateway: MoodleGateway, now = () => Date.now()) {
  // Cache only within one request/CLI invocation; long-lived MCP servers create a fresh service per call.
  let coursesPromise: Promise<Course[]> | undefined;
  let userPromise: ReturnType<MoodleGateway["getUser"]> | undefined;
  const courses = () => coursesPromise ??= gateway.listCourses();
  const user = () => userPromise ??= gateway.getUser();
  const timezone = async () => timezoneFor((await user()).timezone).timezone;
  const course = async (ref: string | number) => {
    if (String(ref).includes("://")) {
      const url = new URL(String(ref));
      const site = new URL((await user()).siteurl);
      if (url.origin !== site.origin) throw new ReferenceError("not_found", "The URL belongs to a different Moodle site.", []);
    }
    return resolveUnit(ref, await courses());
  };
  const selected = async (ref?: string | number) => ref === undefined ? courses() : [await course(ref)];
  const overview = async (days: number): Promise<Overview> => gateway.getOverview({ todoDays: days, todoLimit: Number.MAX_SAFE_INTEGER, alertsLimit: 1 });
  const compactCurrent = (c: Course, sections: Awaited<ReturnType<MoodleGateway["getCourse"]>>["sections"], tz: string) => {
    const result = currentSection(c, sections, now());
    return result ? { id: result.section.id, name: result.section.name, estimated: result.estimated, range_estimated: result.range_estimated, start_at: result.start_at, end_at: result.end_at, start: isoTime(result.start_at, tz), end: isoTime(result.end_at, tz) } : undefined;
  };

  async function find(query: string, ref?: string | number, types?: string[]): Promise<SearchMatch[]> {
    const units = await selected(ref);
    const rows: SearchMatch[] = [];
    for (const c of units) {
      const { sections } = await gateway.getCourse({ courseId: c.id });
      rows.push(...searchSections(c, sections, query === "*" ? "" : query));
    }
    // Thread subjects are a fallback to avoid a forum crawl for ordinary file/activity queries.
    if (!rows.length && (!types || types.includes("thread"))) {
      for (const c of units) {
        for (const forum of await gateway.listForums({ courseId: c.id })) {
          for (const thread of await gateway.listThreads?.(forum.id) ?? []) {
            if (tokensMatch(thread.subject, query)) rows.push({ id: thread.id, name: thread.subject, type: "thread", unit_id: c.id, unit_code: c.shortname || c.fullname, section_id: 0, section: "", score: 50 });
          }
        }
      }
    }
    const filtered = types?.length ? rows.filter(r => types.includes(r.type ?? "")) : rows;
    const useful = filtered.filter(r => r.score > 1);
    return (useful.length ? useful : filtered).sort((a, b) => b.score - a.score || a.id - b.id);
  }

  async function resolveItem(ref: string | number): Promise<number> {
    const raw = String(ref).trim();
    if (/^\d+$/u.test(raw)) return Number(raw);
    if (raw.includes("://")) {
      const url = new URL(raw);
      if (url.origin !== new URL((await user()).siteurl).origin || !/\/mod\/[^/]+\/view.php$/u.test(url.pathname)) throw new ReferenceError("not_found", "Use an activity URL from the configured Moodle site.", []);
      const id = Number(url.searchParams.get("id"));
      if (Number.isSafeInteger(id) && id > 0) return id;
      throw new ReferenceError("not_found", "The activity URL has no valid id.", []);
    }
    const parsed = splitUnitPhrase(raw, await courses());
    const matches = (await find(parsed?.query || raw, parsed?.course.id)).filter(r => r.type !== "section" && r.type !== "thread");
    if (matches.length === 1) return matches[0].id;
    throw new ReferenceError(matches.length ? "ambiguous" : "not_found", `${matches.length ? "Several items match" : "No item matches"} '${raw}'.`, matches.map(({ id, name, type, unit_code }) => ({ id, name, type, code: unit_code })));
  }

  async function run(name: Intent, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const input = intentContracts[name].input.parse(args) as Record<string, unknown>;
    const ref = input.unit as string | number | undefined;
    const limit = Number(input.limit ?? 20);
    let result: unknown;
    switch (name) {
      case "units": { const rows = await courses(); result = { units: rows.slice(0, limit).map(c => unitRow(c)), total: rows.length }; break; }
      case "unit": {
        const c = await course(ref!);
        const { sections } = await gateway.getCourse({ courseId: c.id });
        const tz = await timezone();
        const chosen = input.section !== undefined ? resolveSection(input.section as string | number, sections) : undefined;
        const rows = chosen ? [chosen.section] : sections;
        result = { unit: { ...unitRow(c, tz), current_section: compactCurrent(c, sections, tz) }, sections: rows.map(s => ({ id: s.id, name: s.name, activity_count: s.activities.length, hidden: s.visible === false ? true : undefined, positional: chosen?.positional, activities: chosen ? s.activities.filter(a => a.modname !== "label").map(a => activityRow(a, s)) : undefined })), total: rows.length };
        break;
      }
      case "find": { const rows = await find(String(input.query), ref, input.types as string[] | undefined); result = { results: rows.slice(0, limit).map(({ activity, ...row }) => ({ ...row, files: activity?.file_entries })), total: rows.length }; break; }
      case "item": {
        const id = await resolveItem(input.ref as string | number);
        const activity = await gateway.getActivity({ activityId: id });
        const threads = activity.type === "forum" ? await gateway.listThreads?.(id) : undefined;
        let due: Record<string, unknown> = {};
        if (["assign", "quiz"].includes(activity.type)) {
          const deadlines = await overview(365).catch(() => undefined);
          const dates = deadlines?.todo.filter(t => dueRow(t, deadlines.courses).activity_id === id) ?? [];
          if (dates.length === 1) due = { due_at: dates[0].due_at, due: isoTime(dates[0].due_at, timezoneFor(deadlines?.user?.timezone).timezone) };
        }
        result = { item: { ...itemRow(activity), ...due }, threads: threads?.slice(0, 20).map(t => ({ id: t.id, name: t.subject })), total: threads?.length };
        break;
      }
      case "home": case "due": {
        const data = name === "due" && gateway.getDue
          ? { user: await user(), courses: await courses(), todo: await gateway.getDue(Number(input.days)), errors: [] }
          : await overview(Number(input.days));
        const tz = timezoneFor(data.user?.timezone);
        const target = ref === undefined ? undefined : await course(ref);
        const todos = data.todo.filter(t => target === undefined || t.course_id === target.id);
        const due = todos.slice(0, name === "home" ? 5 : limit).map(t => dueRow(t, data.courses, tz.timezone));
        if (name === "due") { if (data.errors.length) throw new Error("Moodle could not load the complete deadline list."); result = { due, total: todos.length }; break; }
        const units = [];
        const errors = [...data.errors];
        for (const c of data.courses) {
          try { const detail = await gateway.getCourse({ courseId: c.id }); units.push({ id: c.id, code: c.shortname, name: c.fullname, current_section: compactCurrent(c, detail.sections, tz.timezone) }); }
          catch { units.push({ id: c.id, code: c.shortname, name: c.fullname }); errors.push(`Could not load sections for unit ${c.id}.`); }
        }
        const unread = Object.fromEntries(Object.entries(data.alerts ?? {}).filter(([, v]) => typeof v === "number" && v > 0));
        result = { home: { today: isoTime(now() / 1000, tz.timezone)!.slice(0, 10), ...tz, name: data.user?.fullname, siteurl: data.user?.siteurl, units, due, total: todos.length, unread, errors } };
        break;
      }
      case "grades": {
        const units = await selected(ref);
        const rows = [];
        const tz = await timezone();
        const deadlines = await overview(365);
        for (const c of units) {
          const g = await gateway.getGrades({ courseId: c.id });
          const graded = (grade: string) => Boolean(grade && !/^[\s–—-]+$/u.test(grade));
          const items = g.items.filter(i => !input.graded_only || graded(i.grade)).map(i => {
            const matches = deadlines.todo.filter(t => t.course_id === c.id && (t.activity_name || t.name) === i.name);
            const due = matches.length === 1 && !graded(i.grade) ? matches[0].due_at : undefined;
            return { ...i, type: i.item_type, due_at: due, due: isoTime(due, tz) };
          });
          rows.push({ unit_id: c.id, code: c.shortname || c.fullname, graded: g.items.filter(i => graded(i.grade)).length, total: g.items.length, total_grade: g.total_grade, total_range: g.total_range, total_percentage: g.total_percentage, items });
        }
        result = { grades: rows, total: units.length }; break;
      }
      case "news": {
        const units = await selected(ref);
        const rows = [];
        const tz = await timezone();
        for (const c of units) {
          const forums = await gateway.listNewsForums?.(c.id) ?? [];
          for (const forum of forums) {
            for (const t of await gateway.listThreads?.(forum.id) ?? []) {
              const thread = await gateway.getThread({ discussionId: t.id });
              const first = [...thread.posts].sort((a, b) => a.time_created - b.time_created)[0];
              rows.push({ id: t.id, name: t.subject, unit_id: c.id, unit_code: c.shortname || c.fullname, forum_id: forum.id, post: first ? postRow(first, t.subject, tz) : undefined });
            }
          }
        }
        rows.sort((a, b) => (b.post?.time_created ?? 0) - (a.post?.time_created ?? 0));
        result = { news: rows.slice(0, limit), total: rows.length }; break;
      }
      case "thread": {
        const thread = await gateway.getThread({ discussionId: Number(input.discussion_id) });
        const tz = await timezone();
        result = { thread: { id: thread.id, name: thread.subject, unit_id: thread.course_id, forum_id: thread.forum_id, url: thread.url, posts: thread.posts.slice(Number(input.offset), Number(input.offset) + limit).map(p => postRow(p, thread.subject, tz)), posts_total: thread.posts.length, offset: input.offset } }; break;
      }
      case "search_forums": {
        const unitId = ref === undefined ? input.courseId as number | undefined : (await course(ref)).id;
        const rows = await gateway.searchForums({ query: String(input.query), courseId: unitId, forumId: input.forumId as number | undefined, includePostText: true, titlesOnly: Boolean(input.titlesOnly), unreadOnly: Boolean(input.unreadOnly), sortBy: input.sortBy as "relevance" | "recent", maxForums: Number(input.maxForums), maxDiscussionsPerForum: Number(input.maxDiscussionsPerForum), limit: Number.MAX_SAFE_INTEGER });
        const page = rows.slice(0, limit);
        const units = await courses();
        result = { results: page.map(r => ({ unit_id: r.course_id, forum_id: r.forum_id, discussion_id: r.discussion_id, name: r.discussion_subject, post_id: r.post_id, snippet: input.includePostText ? r.snippet : undefined, url: r.url, time_created: r.time_created })), total: rows.length, forums: Object.fromEntries(page.map(r => [r.forum_id, r.forum_name])), units: Object.fromEntries(page.map(r => [r.course_id, units.find(c => c.id === r.course_id)?.shortname || r.course_name])), scope: { max_forums: input.maxForums, max_discussions_per_forum: input.maxDiscussionsPerForum } }; break;
      }
      case "file": {
        const source = await fileSource(input.ref as string | number);
        const file = await gateway.getFile({ source });
        result = { file: { name: file.name, mime_type: file.mimeType, bytes: file.bytes, uri: file.uri } }; break;
      }
    }
    return intentContracts[name].output.parse(stripEmpty(result)) as Record<string, unknown>;
  }
  async function fileSource(ref: string | number): Promise<string | number> {
    return String(ref).includes("://") ? ref : resolveItem(ref);
  }
  return { run, resolveItem, fileSource, find };
}
