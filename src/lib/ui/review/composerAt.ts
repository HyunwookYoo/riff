import { isCommentable } from "../../review/commentable";
import type { FileHunks, Side } from "../../review/types";

/** An open line composer; `anchor` is the first clicked line a shift-click extends from. */
export type ComposerAt = { path: string; side: Side; anchor: number; line: number; startLine: number | null };

export const RANGE_NOTE = "A range must stay inside one diff hunk.";

/** Identifies what the composer comments on (not the anchor); also its widget key. */
export function composerKey(c: ComposerAt): string {
  return `c:${c.path}|${c.side}|${c.startLine}|${c.line}`;
}

/**
 * The composer after a "+" click. Returns `cur` itself when the target does not
 * change, so its widget (and typed text) stays as is.
 */
export function clickComposer(
  cur: ComposerAt | null,
  at: { path: string; side: Side; line: number; shift: boolean },
  fh: FileHunks | undefined,
): { composer: ComposerAt | null; note: string | null } {
  let next: ComposerAt;
  if (at.shift && cur && cur.path === at.path && cur.side === at.side) {
    const start = Math.min(cur.anchor, at.line);
    const end = Math.max(cur.anchor, at.line);
    if (start !== end && !isCommentable(fh, at.side, end, start)) return { composer: cur, note: RANGE_NOTE };
    next = { ...cur, line: end, startLine: start === end ? null : start };
  } else {
    next = { path: at.path, side: at.side, anchor: at.line, line: at.line, startLine: null };
  }
  return { composer: cur && composerKey(cur) === composerKey(next) ? cur : next, note: null };
}

/**
 * Unsaved inline text by widget key. CodeMirror destroys widgets that leave
 * the viewport and redraws them later, so components read this on mount.
 * An entry also marks a reply/edit box as open.
 */
export const textStash = new Map<string, string>();
