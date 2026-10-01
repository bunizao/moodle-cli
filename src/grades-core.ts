import type { GradeItem } from "./models.js";

export function hasGrade(grade: string): boolean {
  return Boolean(grade.trim() && !/^[\s–—−-]+$/u.test(grade));
}

export function gradeActivity(item: GradeItem): { type: string; id?: number } {
  // Moodle's icon alt text is translated; the module URL is stable across locales.
  try {
    const url = new URL(item.url);
    const match = /\/mod\/([^/]+)\/view\.php$/u.exec(url.pathname);
    if (match) {
      const id = Number(url.searchParams.get("id"));
      return { type: match[1], id: Number.isSafeInteger(id) && id > 0 ? id : undefined };
    }
  } catch { /* Manual grade items may not have an activity URL. */ }
  const type = item.item_type.trim().toLowerCase();
  return { type: type === "assignment" ? "assign" : type };
}
