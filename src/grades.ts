export function hasGrade(grade: string): boolean {
  return Boolean(grade.trim() && !/^[\s–—−-]+$/u.test(grade));
}

export function pageGradeReports<T, R extends { items: T[] }>(reports: readonly R[], limit: number, offset: number) {
  // Enrollment order is preserved; one budget covers all already-filtered units.
  let matched = 0, returned = 0;
  const pages = reports.map(report => {
    const start = Math.max(0, offset - matched);
    matched += report.items.length;
    const items = report.items.slice(start, start + limit - returned);
    returned += items.length;
    return { ...report, items };
  });
  return { pages, matched, returned, offset, has_more: offset + returned < matched };
}
