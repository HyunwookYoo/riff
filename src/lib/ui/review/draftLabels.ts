import type { DraftItem } from "$lib/review/types";

export function itemLocation(i: DraftItem): string {
  const t = i.target;
  switch (t.kind) {
    case "line":
      return t.startLine !== null ? `${t.path}:${t.startLine}-${t.line}` : `${t.path}:${t.line}`;
    case "file":
      return `${t.path} (file)`;
    case "body":
      return "review body";
    case "reply":
      return "reply to thread";
  }
}

const ORIGIN = { ai: "AI draft", "ai-edited": "AI draft, edited", "ai-unconfirmed": "Unconfirmed" } as const;

export function originTag(i: DraftItem): string {
  if (i.origin !== "mine") return ORIGIN[i.origin];
  return i.target.kind === "reply" ? "reply" : "mine";
}

/** One line of context: the first quoted code line, or the replied-to comment. */
export function itemPreview(i: DraftItem): string | null {
  const t = i.target;
  if (t.kind === "line") return t.quote[0] ?? null;
  if (t.kind === "reply") return t.preview;
  return null;
}
