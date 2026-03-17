"""Shared helpers for converting Moodle HTML content into terminal-friendly text."""

from __future__ import annotations

from urllib.parse import urljoin

from bs4 import BeautifulSoup


def html_to_text_and_image_urls(html: str, base_url: str) -> tuple[str, list[str]]:
    """Convert HTML to plain text while preserving image URLs."""
    text, image_urls, _links, _tables = html_to_structured_content(html, base_url)
    return text, image_urls


def html_to_structured_content(html: str, base_url: str) -> tuple[str, list[str], list[dict[str, str]], list[dict[str, list]]]:
    """Convert HTML to plain text while preserving images, links, and tables."""
    if not html:
        return "", [], [], []

    soup = BeautifulSoup(html, "html.parser")
    image_urls: list[str] = []
    links: list[dict[str, str]] = []
    tables: list[dict[str, list]] = []

    for br in soup.select("br"):
        br.replace_with("\n")

    for img in soup.select("img"):
        src = (img.get("src") or "").strip()
        if src:
            abs_src = urljoin(base_url, src)
            image_urls.append(abs_src)
            alt = (img.get("alt") or "").strip()
            label = alt if alt else "image"
            img.replace_with(f"[{label}] {abs_src}")
        else:
            img.replace_with("[image]")

    for link in soup.select("a[href]"):
        href = (link.get("href") or "").strip()
        if not href:
            continue
        text = " ".join(link.get_text(" ", strip=True).split())
        links.append({"text": text, "url": urljoin(base_url, href)})

    for table in soup.select("table"):
        headers: list[str] = []
        rows: list[list[str]] = []

        for row in table.select("tr"):
            header_cells = row.select("th")
            data_cells = row.select("td")
            cells = header_cells or data_cells
            if not cells:
                continue

            values = [" ".join(cell.get_text("\n", strip=True).split()) for cell in cells]
            if header_cells and not headers and not rows:
                headers = values
                continue
            rows.append(values)

        if headers or rows:
            tables.append({"headers": headers, "rows": rows})

    text = soup.get_text("\n", strip=True)
    lines = [line.strip() for line in text.splitlines()]
    cleaned = "\n".join([line for line in lines if line])
    return cleaned, image_urls, links, tables
