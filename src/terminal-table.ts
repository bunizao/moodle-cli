import Table from "cli-table3";

const DEFAULT_WIDTH = 120;
const MIN_TABLE_WIDTH = 40;

export interface TerminalTableColumn {
  readonly label: string;
  readonly maxWidth?: number;
  readonly minWidth?: number;
}

export function renderTerminalTable(
  columns: readonly TerminalTableColumn[],
  rows: readonly (readonly string[])[],
  options: { readonly title?: string; readonly width?: number } = {},
): string {
  const values = rows.map((row) => columns.map((_, index) => sanitizeTerminalText(row[index] ?? "")));
  const widths = fitWidths(columns, values, options.width ?? process.stdout.columns ?? DEFAULT_WIDTH);
  const table = new Table({
    chars: {
      top: "━",
      "top-mid": "┳",
      "top-left": "┏",
      "top-right": "┓",
      bottom: "━",
      "bottom-mid": "┻",
      "bottom-left": "┗",
      "bottom-right": "┛",
      left: "┃",
      "left-mid": "┣",
      mid: "─",
      "mid-mid": "┿",
      right: "┃",
      "right-mid": "┫",
      middle: "│",
    },
    colWidths: widths,
    head: columns.map((column) => column.label),
    style: { border: [], compact: true, head: [] },
    truncate: "…",
    wordWrap: true,
    wrapOnWordBoundary: true,
  });
  table.push(...values);
  return withTitle(table.toString(), options.title);
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
    { label: "Field", maxWidth: 24, minWidth: 10 },
    { label: "Value", minWidth: 20 },
  ];
  return renderTerminalTable(columns, present, options);
}

function fitWidths(
  columns: readonly TerminalTableColumn[],
  rows: readonly (readonly string[])[],
  requestedWidth: number,
): number[] {
  const widths = columns.map((column, index) => {
    const natural = Math.max(column.label.length, ...rows.map((row) => longestLine(row[index] ?? ""))) + 2;
    return Math.min(natural, (column.maxWidth ?? natural - 2) + 2);
  });
  const minimums = columns.map((column) => Math.max(5, (column.minWidth ?? Math.min(column.label.length, 10)) + 2));
  const tableWidth = Math.max(MIN_TABLE_WIDTH, requestedWidth);
  let excess = widths.reduce((sum, width) => sum + width, columns.length + 1) - tableWidth;

  excess = shrinkWidths(widths, minimums, excess);
  shrinkWidths(widths, columns.map(() => 3), excess);
  return widths;
}

function shrinkWidths(widths: number[], minimums: readonly number[], initialExcess: number): number {
  let excess = initialExcess;
  while (excess > 0) {
    let widest = -1;
    let room = 0;
    for (let index = 0; index < widths.length; index += 1) {
      const available = (widths[index] ?? 0) - (minimums[index] ?? 0);
      if (available > room) {
        room = available;
        widest = index;
      }
    }
    if (widest === -1) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
    excess -= 1;
  }
  return excess;
}

function longestLine(value: string): number {
  return Math.max(0, ...value.split("\n").map((line) => Array.from(line).length));
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

function withTitle(table: string, title?: string): string {
  if (!title) return table;
  const width = table.split("\n", 1)[0]?.length ?? title.length;
  const padding = Math.max(0, Math.floor((width - Array.from(title).length) / 2));
  return `${" ".repeat(padding)}${title}\n${table}`;
}
