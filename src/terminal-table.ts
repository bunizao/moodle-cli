const DEFAULT_WIDTH = 120;
export interface TerminalTableColumn { readonly label: string; readonly width?: number; readonly flex?: boolean }

export function renderTerminalTable(columns: readonly TerminalTableColumn[], rows: readonly (readonly string[])[], options: { readonly title?: string; readonly width?: number } = {}): string {
  const width = Math.max(20, options.width ?? process.stdout.columns ?? DEFAULT_WIDTH);
  const clean = rows.map(row => columns.map((_, i) => sanitizeTerminalText(row[i] ?? "").replace(/\s+/gu, " ")));
  const lengths = columns.map((c, i) => Math.max(c.label.length, ...clean.map(r => Array.from(r[i]).length)));
  const flexible = columns.map((c, i) => c.flex || /name|title|subject|feedback|description|value|course|unit/iu.test(c.label) ? i : -1).filter(i => i >= 0);
  const widths = columns.map((c, i) => c.width ?? (flexible.includes(i) ? Math.min(lengths[i], 36) : lengths[i]));
  const minimum = widths.reduce((n, w, i) => n + (flexible.includes(i) ? 8 : w), 0) + columns.length * 3 + 1;
  const title = options.title ? [sanitizeTerminalText(options.title)] : [];
  if (width < 60 || minimum > width) {
    const wrap = (line: string) => Array.from(line).reduce<string[]>((lines, char) => { if (!lines.length || Array.from(lines.at(-1)!).length >= width) lines.push(""); lines[lines.length - 1] += char; return lines; }, []);
    return [...title, ...clean.flatMap(row => [...columns.flatMap((c, i) => wrap(`${c.label}: ${row[i]}`)), ""])].join("\n").trimEnd();
  }
  while (widths.reduce((n, v) => n + v, 0) + columns.length * 3 + 1 > width) {
    const index = flexible.reduce((best, i) => widths[i] > (widths[best] ?? 0) ? i : best, -1);
    if (index < 0 || widths[index] <= 8) break;
    widths[index]--;
  }
  const fit = (v: string, w: number) => { const chars = Array.from(v); const trimmed = chars.length > w ? `${chars.slice(0, w - 1).join("")}…` : v; return trimmed + " ".repeat(Math.max(0, w - Array.from(trimmed).length)); };
  const border = (l: string, m: string, r: string) => l + widths.map(w => "─".repeat(w + 2)).join(m) + r;
  const line = (row: readonly string[]) => "│" + widths.map((w, i) => ` ${fit(row[i] ?? "", w)} `).join("│") + "│";
  return [...title, border("┌", "┬", "┐"), line(columns.map(c => c.label)), border("├", "┼", "┤"), ...clean.map(line), border("└", "┴", "┘")].join("\n");
}

export function renderKeyValueTable(
  rows: readonly (readonly [string, string])[],
  options: { readonly title?: string; readonly width?: number } = {},
): string {
  const present = rows.filter(([, value]) => value !== "");
  if (present.length === 0) {
    return options.title ? `${options.title}\nNo details` : "No details";
  }
  const columns: readonly TerminalTableColumn[] = [
    { label: "Field" },
    { label: "Value" },
  ];
  return renderTerminalTable(columns, present, options);
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}
