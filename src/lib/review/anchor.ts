import { isCommentable } from "./commentable";
import type { DraftTarget, FileHunks } from "./types";

type LineTarget = Extract<DraftTarget, { kind: "line" }>;

/** Finds the quote in `sideText` (the file text on the target's side) nearest its old position. */
export function reanchor(
  t: LineTarget,
  sideText: string,
  fh: FileHunks | undefined,
): { line: number; startLine: number | null } | null {
  const n = t.quote.length;
  if (n === 0) return null;
  const lines = sideText.split("\n").map((l) => l.trimEnd());
  const quote = t.quote.map((l) => l.trimEnd());
  const old = t.startLine ?? t.line;
  let best = -1;
  for (let i = 0; i + n <= lines.length; i++) {
    if (!quote.every((q, j) => lines[i + j] === q)) continue;
    if (best < 0 || Math.abs(i + 1 - old) < Math.abs(best + 1 - old)) best = i;
  }
  if (best < 0) return null;
  const start = best + 1;
  const line = start + n - 1;
  const startLine = n > 1 ? start : null;
  return isCommentable(fh, t.side, line, startLine) ? { line, startLine } : null;
}
