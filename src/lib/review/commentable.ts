import type { FileHunks, Side } from "./types";

export function isCommentable(fh: FileHunks | undefined, side: Side, line: number, startLine?: number | null): boolean {
  if (!fh) return false;
  const from = startLine ?? line;
  return fh.hunks.some((h) => {
    const start = side === "RIGHT" ? h.newStart : h.oldStart;
    const count = side === "RIGHT" ? h.newLines : h.oldLines;
    return from <= line && from >= start && line < start + count;
  });
}

export function placeTarget(path: string, side: Side, line: number, startLine: number | null, files: FileHunks[]): "line" | "file" | "body" {
  const fh = files.find((f) => f.path === path);
  if (!fh) return "body";
  return isCommentable(fh, side, line, startLine) ? "line" : "file";
}
