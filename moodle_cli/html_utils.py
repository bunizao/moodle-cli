"""Shared helpers for converting Moodle HTML content into terminal-friendly text."""

from __future__ import annotations

from urllib.parse import urljoin

from bs4 import BeautifulSoup


def html_to_text_and_image_urls(html: str, base_url: str) -> tuple[str, list[str]]:
    """Convert HTML to plain text while preserving image URLs."""
    if not html:
        return "", []

    soup = BeautifulSoup(html, "html.parser")
    image_urls: list[str] = []

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

    text = soup.get_text("\n", strip=True)
    lines = [line.strip() for line in text.splitlines()]
    cleaned = "\n".join([line for line in lines if line])
    return cleaned, image_urls

