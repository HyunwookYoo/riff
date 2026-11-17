import DOMPurify from "dompurify";

/**
 * Cleans GitHub-rendered HTML (a PR's or comment's `bodyHTML`) before it reaches `{@html}`. GitHub
 * already sanitizes it; this is the app's own guard, since the webview can reach Tauri `invoke`.
 * HTML only: SVG / MathML links and image maps navigate without an `<a>`, past `externalLinks`.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "map", "area"],
    FORBID_ATTR: ["style"],
  });
}

const EXTERNAL = new Set(["http:", "https:", "mailto:"]);

/**
 * The URL a link's raw `href` attribute opens in the system browser / mail client, resolved against
 * `base` (the PR page, as on GitHub; "" resolves nothing), else null: in-page, empty, other schemes.
 */
export function externalUrl(href: string, base: string): string | null {
  if (href === "" || href.startsWith("#")) return null;
  try {
    const url = base ? new URL(href, base) : new URL(href);
    return EXTERNAL.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
