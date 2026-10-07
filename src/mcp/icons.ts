import type { Intent } from "../intent-contract.js";

// MCP icons (spec 2025-11-25). Every icon is a self-contained data: URI: a stdio
// server has no origin to serve from, and clients reject icons from other origins.
// Each glyph sits on a filled tile, so one variant reads on light and dark hosts.
export interface McpIcon {
  src: string;
  mimeType: string;
  sizes: string[];
}

const BRAND = "#c2410c";
// Matches the destructive annotation: the only tool that writes stands out.
const WRITE = "#b91c1c";

const GLYPHS: Record<Intent, string> = {
  home: "M6 11 12 6l6 5v8H6zM10.5 19v-4.5h3V19",
  due: "M7 7.5h10a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1zM6 11.5h12M9.5 5.5V9M14.5 5.5V9",
  units: "M7 6v13M10.5 6v13M14 6.5l4 12.5",
  unit: "M12 8.5c-1.5-1.5-3.5-2-6-2v11c2.5 0 4.5.5 6 2 1.5-1.5 3.5-2 6-2v-11c-2.5 0-4.5.5-6 2zm0 0v11",
  find: "M15.5 11a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM14.2 14.2 18 18",
  item: "M9 6.5H8a1 1 0 0 0-1 1V18a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1h-1M10 5.5h4v2h-4zM10 11.5h4M10 15h4",
  attempt: "M6 8l1.5 1.5L10 7M6 15l1.5 1.5L10 14M12.5 8.5H18M12.5 15.5H18",
  grades: "M6 18.5h12M8 16v-3M12 16V7.5M16 16v-5.5",
  news: "M6 10.5 17.5 7v10L6 13.5zM9.5 14.5v2a1.5 1.5 0 0 0 3 0v-1.2",
  thread: "M7 6.5h10a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1h-6l-3.5 3v-3H7a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1zM9 9.5h6M9 12h4",
  search_forums: "M16 10V7.5a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1V13a1 1 0 0 0 1 1h1v2.5l2.5-2.5h1M17.5 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM16.8 17.3l1.7 1.7",
  submit: "M12 15V6M8.5 9.5 12 6l3.5 3.5M6 14.5V17a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 17v-2.5",
  file: "M12 6v9M8.5 11.5 12 15l3.5-3.5M6 14.5V17a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 17v-2.5",
};

// A mortarboard over a shell prompt: Moodle, from a terminal.
const BRAND_GLYPH = `<path d="M12 4.5 19.5 8 12 11.5 4.5 8z" fill="#fff"/><path d="M19.5 8v3.5M7.5 14l2.5 2.5L7.5 19M12.5 19h4" fill="none" stroke="#fff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`;

function tileSvg(fill: string, glyph: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="${fill}"/>${glyph}</svg>`;
}

function strokeGlyph(d: string): string {
  return `<path d="${d}" fill="none" stroke="#fff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function svgIcon(svg: string): McpIcon {
  return { src: `data:image/svg+xml;base64,${btoa(svg)}`, mimeType: "image/svg+xml", sizes: ["any"] };
}

export const BRAND_SVG = tileSvg(BRAND, BRAND_GLYPH);

// SVG support is only a SHOULD for clients; PNG is a MUST, so the server icon
// carries both. Regenerate after changing BRAND_SVG:
//   rsvg-convert -w 128 -h 128 brand.svg | base64
export const BRAND_PNG_BASE64 =
  "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";

export const SERVER_ICONS: McpIcon[] = [
  svgIcon(BRAND_SVG),
  { src: `data:image/png;base64,${BRAND_PNG_BASE64}`, mimeType: "image/png", sizes: ["128x128"] },
];

export const TOOL_ICONS = Object.fromEntries(
  Object.entries(GLYPHS).map(([name, d]) => [name, [svgIcon(tileSvg(name === "submit" ? WRITE : BRAND, strokeGlyph(d)))]]),
) as Record<Intent, McpIcon[]>;
