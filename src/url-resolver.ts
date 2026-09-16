import { resolveUnit } from "./resolve.js";
import { UsageError } from "./errors.js";

export interface ResolvedURLTarget {
  commandName: string;
  args?: string[];
  kwargs?: Record<string, unknown>;
}

export function looksLikeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol && parsed.host);
  } catch {
    return false;
  }
}

export interface ResolveTopLevelUrlOptions {
  baseUrl: string;
  target: string;
  resolveCourseIdForUrl?: (url: string) => number | null | Promise<number | null>;
}

export function resolveTopLevelUrl(options: ResolveTopLevelUrlOptions): ResolvedURLTarget;
export function resolveTopLevelUrl(
  baseUrl: string,
  target: string,
  resolveCourseIdForUrl?: (url: string) => Promise<number | null> | number | null,
): ResolvedURLTarget | Promise<ResolvedURLTarget>;
export function resolveTopLevelUrl(
  baseUrlOrOptions: string | ResolveTopLevelUrlOptions,
  targetValue?: string,
  resolveCourseIdForUrlValue?: (url: string) => Promise<number | null> | number | null,
): ResolvedURLTarget | Promise<ResolvedURLTarget> {
  const objectMode = typeof baseUrlOrOptions !== "string";
  const baseUrl = objectMode ? baseUrlOrOptions.baseUrl : baseUrlOrOptions;
  const target = objectMode ? baseUrlOrOptions.target : targetValue ?? "";
  const resolveCourseIdForUrl = objectMode ? baseUrlOrOptions.resolveCourseIdForUrl : resolveCourseIdForUrlValue;
  let parsed: URL;
  try {
    parsed = new URL(target.trim());
  } catch {
    throw new UsageError(`No such command '${target}'.`);
  }

  const configuredHost = new URL(baseUrl).host.toLowerCase();
  if (parsed.host.toLowerCase() !== configuredHost) {
    throw new UsageError(`URL host '${parsed.host.toLowerCase()}' does not match configured Moodle site '${configuredHost}'.`);
  }

  const path = parsed.pathname.replace(/\/$/, "");
  const intParam = (key: string, label: string): string => {
    const value = parsed.searchParams.get(key);
    if (!value || !/^\d+$/.test(value)) {
      throw new UsageError(`Could not find ${label} in URL query (expected ?${key}=...).`);
    }
    return value;
  };

  if (path.endsWith("/mod/forum/discuss.php")) {
    return objectMode
      ? { commandName: "forum_discussion", kwargs: { discussion: intParam("d", "discussion ID"), postId: parsed.hash, asJson: false, asYaml: false } }
      : { commandName: "forum:discussion", args: [intParam("d", "discussion ID"), parsed.hash] };
  }
  if (path.endsWith("/mod/forum/view.php")) {
    return objectMode
      ? { commandName: "forum_discussions", kwargs: { forum: intParam("id", "forum module ID"), asJson: false, asYaml: false } }
      : { commandName: "forum:discussions", args: [intParam("id", "forum module ID")] };
  }
  if (path.endsWith("/mod/assign/view.php")) {
    const id = intParam("id", "assignment module ID");
    return objectMode ? { commandName: "assign", kwargs: { assign: id, asJson: false, asYaml: false } } : { commandName: "assign", args: [id] };
  }
  if (path.endsWith("/mod/quiz/view.php")) {
    const id = intParam("id", "quiz module ID");
    return objectMode ? { commandName: "quiz", kwargs: { quiz: id, asJson: false, asYaml: false } } : { commandName: "quiz", args: [id] };
  }
  if (path.endsWith("/mod/resource/view.php")) {
    const id = intParam("id", "resource module ID");
    return objectMode ? { commandName: "resource", kwargs: { resource: id, asJson: false, asYaml: false } } : { commandName: "resource", args: [id] };
  }
  if (path.endsWith("/mod/url/view.php")) {
    const id = intParam("id", "link module ID");
    return objectMode ? { commandName: "link", kwargs: { link: id, asJson: false, asYaml: false } } : { commandName: "link", args: [id] };
  }
  if (path.endsWith("/mod/page/view.php")) {
    const id = intParam("id", "page module ID");
    return objectMode ? { commandName: "page", kwargs: { page: id, asJson: false, asYaml: false } } : { commandName: "page", args: [id] };
  }
  if (path.endsWith("/mod/folder/view.php")) {
    const id = intParam("id", "folder module ID");
    return objectMode ? { commandName: "folder", kwargs: { folder: id, asJson: false, asYaml: false } } : { commandName: "folder", args: [id] };
  }
  if (path.endsWith("/course/view.php")) {
    const id = intParam("id", "course ID");
    return objectMode ? { commandName: "course", kwargs: { course: id, asJson: false, asYaml: false } } : { commandName: "course", args: [id] };
  }
  if ((path.endsWith("/course/user.php") && parsed.searchParams.get("mode") === "grade") || path.includes("/grade/report/")) {
    const id = intParam("id", "course ID");
    return objectMode ? { commandName: "grades", kwargs: { course: id, asJson: false, asYaml: false } } : { commandName: "grades", args: [id] };
  }
  if (path.includes("/mod/") && path.endsWith("/view.php")) {
    if (!resolveCourseIdForUrl) {
      throw new UsageError("Could not resolve course ID from the activity page.");
    }
    const finish = (courseId: number | null): ResolvedURLTarget => {
      if (!courseId) {
        throw new UsageError("Could not resolve course ID from the activity page.");
      }
      return objectMode
        ? { commandName: "course", kwargs: { course: String(courseId), asJson: false, asYaml: false } }
        : { commandName: "course", args: [String(courseId)] };
    };
    const courseId = resolveCourseIdForUrl(target);
    return courseId instanceof Promise ? courseId.then(finish) : finish(courseId);
  }

  throw new UsageError("Unsupported Moodle URL. Supported paths: forum, activity, course, and grade report URLs.");
}

export function parseActivityReference(value: string, options: { label: string; path: string }): number;
export function parseActivityReference(value: string, label: string, expectedPath: string): number;
export function parseActivityReference(value: string, labelOrOptions: string | { label: string; path: string }, expectedPathValue?: string): number {
  const label = typeof labelOrOptions === "string" ? labelOrOptions : labelOrOptions.label;
  const expectedPath = typeof labelOrOptions === "string" ? expectedPathValue ?? "" : labelOrOptions.path;
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UsageError(`${label} must be a numeric ID or a full ${label.toLowerCase()} URL.`);
  }
  if (!parsed.pathname.endsWith(expectedPath)) {
    throw new UsageError(`Unsupported ${label.toLowerCase()} URL. Use a view.php?id=... URL.`);
  }
  const id = parsed.searchParams.get("id");
  if (!id || !/^\d+$/.test(id)) {
    throw new UsageError(`Could not find ${label.toLowerCase()} module ID in view.php URL (expected ?id=...).`);
  }
  return Number(id);
}

export function resolveCourseReference(value: string, courses: Array<{ id: number; fullname: string; shortname: string }>): number {
  return resolveUnit(value, courses.map(course => ({ ...course, category: 0, visible: true, startdate: 0 }))).id;
}
