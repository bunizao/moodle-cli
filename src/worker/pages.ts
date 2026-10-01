// Server-rendered pages for the authorization and sign-in flows. The CSP allows no
// scripts or external assets, so every page is plain HTML with inline styles.

export function htmlResponse(body: string, status = 200, redirectUri?: string): Response {
  const callback = redirectUri ? ` ${new URL(redirectUri).origin}` : "";
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callback}; frame-ancestors 'none'`,
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    },
  });
}

// Colours follow the OS so the page never glares in a dark client; every rule is
// inline because the CSP allows no external assets.
const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--line:#dfe2e8;--text:#16181d;--muted:#5b6472;--accent:#16181d;--accent-text:#fff;--danger:#a3111c;--ok:#0f6b3a;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e23;--line:#2c313a;--text:#e8eaee;--muted:#9aa3b0;--accent:#e8eaee;--accent-text:#121417;--danger:#ff8a8a;--ok:#6fd39a}}
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:3rem 1.25rem;background:var(--bg);color:var(--text)}
main{max-width:26rem;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.75rem}
h1{font-size:1.15rem;margin:0 0 .75rem}p{margin:.5rem 0}dl{margin:0 0 1.25rem;font-size:.9rem}dt{color:var(--muted);margin-top:.5rem}
dd{margin:0;word-break:break-all}label{display:block;font-size:.9rem;color:var(--muted);margin-bottom:.35rem}
input{width:100%;box-sizing:border-box;font:1.35rem/1 var(--mono);letter-spacing:.2em;text-align:center;padding:.7rem;
border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);text-transform:uppercase}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;margin-top:1rem;padding:.7rem;font-size:1rem;border:0;border-radius:8px;background:var(--accent);color:var(--accent-text);cursor:pointer}
button.quiet{background:transparent;color:var(--text);border:1px solid var(--line)}
code{font:.9em var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:.05em .35em}
ol{padding-left:1.25rem;margin:.5rem 0 1rem;font-size:.95rem}li{margin:.25rem 0}
.note{font-size:.85rem;color:var(--muted);margin-top:1rem}.error{color:var(--danger);font-size:.9rem;margin:0 0 1rem}
.open{color:var(--ok);font-size:.9rem;margin:0 0 .75rem}
a.button{display:block;box-sizing:border-box;width:100%;margin-top:1rem;padding:.7rem;font-size:1rem;border-radius:8px;background:var(--accent);color:var(--accent-text);text-align:center;text-decoration:none}
hr{border:0;border-top:1px solid var(--line);margin:1.5rem 0 1rem}`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
