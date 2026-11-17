import DOMPurify from "dompurify";

/**
 * Cleans GitHub-rendered HTML (a PR's or comment's `bodyHTML`) before it reaches `{@html}`. GitHub
 * already sanitizes it; this is the app's own guard, since the webview can reach Tauri `invoke`.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form"], FORBID_ATTR: ["style"] });
}

const EXTERNAL = new Set(["http:", "https:", "mailto:"]);

/** `href` when the system browser / mail client may open it, else null (the webview never navigates). */
export function externalUrl(href: string): string | null {
  try {
    return EXTERNAL.has(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}
