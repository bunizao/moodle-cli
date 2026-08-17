import Table from "tty-table";

const DEFAULT_WIDTH = 120;
const MIN_TABLE_WIDTH = 40;

export interface TerminalTableColumn {
  readonly label: string;
}

export function renderTerminalTable(
  columns: readonly TerminalTableColumn[],
  rows: readonly (readonly string[])[],
  options: { readonly title?: string; readonly width?: number } = {},
): string {
  const tableWidth = Math.max(MIN_TABLE_WIDTH, options.width ?? process.stdout.columns ?? DEFAULT_WIDTH);
  const tableColumns = columns.map((column, index) => ({
    align: "left",
    alias: sanitizeTerminalText(column.label),
    headerAlign: "left",
    value: `column_${index}`,
  }));
  const data = rows.map((row) => Object.fromEntries(
    tableColumns.map((column, index) => [column.value, sanitizeTerminalText(row[index] ?? "")]),
  ));
  const tableOptions = {
    COLUMNS: tableWidth,
    compact: true,
    marginLeft: 0,
    marginTop: 0,
    width: String(tableWidth),
  };
  const output = Table(tableColumns, data, tableOptions).render();
  return [options.title ? sanitizeTerminalText(options.title) : "", output].filter(Boolean).join("\n");
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
