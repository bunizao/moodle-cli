import { parse } from "node-html-parser";

export interface StructuredHtmlContent {
  text: string;
  image_urls: string[];
  links: Array<{ text: string; url: string }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
}

export function htmlToStructuredContent(html: string, baseUrl: string): StructuredHtmlContent {
  if (!html) {
    return { text: "", image_urls: [], links: [], tables: [] };
  }

  const root = parse(html);
  const image_urls: string[] = [];
  const links: Array<{ text: string; url: string }> = [];
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];

  for (const br of root.querySelectorAll("br")) {
    br.replaceWith("\n");
  }

  for (const img of root.querySelectorAll("img")) {
    const src = (img.getAttribute("src") ?? "").trim();
    if (!src) {
      img.replaceWith("[image]");
      continue;
    }
    const absolute = resolveUrl(baseUrl, src);
    image_urls.push(absolute);
    const label = (img.getAttribute("alt") ?? "").trim() || "image";
    img.replaceWith(`[${label}] ${absolute}`);
  }

  for (const link of root.querySelectorAll("a[href]")) {
    const href = (link.getAttribute("href") ?? "").trim();
    if (!href) {
      continue;
    }
    links.push({ text: cleanText(link.textContent), url: resolveUrl(baseUrl, href) });
  }

  for (const table of root.querySelectorAll("table")) {
    const headers: string[] = [];
    const rows: string[][] = [];
    for (const row of table.querySelectorAll("tr")) {
      const headerCells = row.querySelectorAll("th");
      const dataCells = row.querySelectorAll("td");
      const cells = headerCells.length ? headerCells : dataCells;
      if (!cells.length) {
        continue;
      }
      const values = cells.map((cell) => cleanText(cell.textContent));
      if (headerCells.length && !headers.length && !rows.length) {
        headers.push(...values);
      } else {
        rows.push(values);
      }
    }
    if (headers.length || rows.length) {
      tables.push({ headers, rows });
    }
  }

  // Block boundaries survive text extraction even when the HTML has no whitespace.
  for (const block of root.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr")) {
    block.insertAdjacentHTML("afterbegin", "\n");
    block.insertAdjacentHTML("beforeend", "\n");
  }

  const text = root.textContent
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join("\n");
  return { text, image_urls, links, tables };
}

export function cleanText(value: string | null | undefined): string {
  return decodeHtml(value ?? "").replace(/\s+/g, " ").trim();
}

export function resolveUrl(baseUrl: string, href: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function filemanagerOptions(html: string, itemid: string): Record<string, unknown> | null {
  const pattern = /M\.form_filemanager\.init\(\s*Y\s*,\s*/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const json = balancedObject(html, match.index + match[0].length);
    if (!json) continue;
    try {
      const options = JSON.parse(json) as unknown;
      if (typeof options === "object" && options !== null && !Array.isArray(options) && String((options as Record<string, unknown>).itemid) === itemid) return options as Record<string, unknown>;
    } catch { /* Not JSON; keep scanning for the next initialiser. */ }
  }
  return null;
}

function balancedObject(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") { depth -= 1; if (depth === 0) return text.slice(start, index + 1); }
  }
  return null;
}
