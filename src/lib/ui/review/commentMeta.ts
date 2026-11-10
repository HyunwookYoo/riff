/** Up to two initials from a login: "alex-kang" → "AK", "kdongil" → "K". */
export function initials(name: string): string {
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((p) => Array.from(p)[0].toUpperCase())
    .join("");
}

/** A stable hue (0..359) per author, so each participant keeps one colour. */
export function authorHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % 360;
}

/** Badges for a comment's author: "You" (the viewer) and/or "Author" (the PR author). */
export function commentRoles(author: string, prAuthor: string | null, viewer: string | null): string[] {
  const same = (a: string | null) => a !== null && a.toLowerCase() === author.toLowerCase();
  const roles: string[] = [];
  if (same(viewer)) roles.push("You");
  if (same(prAuthor)) roles.push("Author");
  return roles;
}
