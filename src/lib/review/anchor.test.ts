import { describe, it, expect } from "vitest";
import { reanchor } from "./anchor";
import type { DraftTarget, FileHunks } from "./types";

type LineT = Extract<DraftTarget, { kind: "line" }>;
const t = (over: Partial<LineT>): LineT => ({ kind: "line", path: "a.ts", side: "RIGHT", line: 5, startLine: null, quote: ["  foo();"], ...over });
const fh = (newStart: number, newLines: number): FileHunks => ({ path: "a.ts", oldPath: null, hunks: [{ oldStart: newStart, oldLines: newLines, newStart, newLines }] });
const text = (lines: Record<number, string>, n: number) =>
  Array.from({ length: n }, (_, i) => lines[i + 1] ?? `x${i + 1}`).join("\n");

describe("reanchor", () => {
  it("reanchor_moves_with_inserted_lines", () => {
    expect(reanchor(t({}), text({ 7: "  foo();" }, 20), fh(1, 20))).toEqual({ line: 7, startLine: null });
  });
  it("reanchor_prefers_nearest_duplicate", () => {
    const s = text({ 3: "  foo();", 40: "  foo();" }, 50);
    expect(reanchor(t({ line: 38 }), s, fh(1, 50))?.line).toBe(40);
  });
  it("reanchor_multi_line_quote", () => {
    const r = reanchor(t({ line: 6, startLine: 5, quote: ["a", "b"] }), text({ 7: "a", 8: "b" }, 20), fh(1, 20));
    expect(r).toEqual({ line: 8, startLine: 7 });
  });
  it("reanchor_ignores_trailing_whitespace", () => {
    expect(reanchor(t({}), text({ 5: "  foo();  \r" }, 10), fh(1, 10))).toEqual({ line: 5, startLine: null });
  });
  it("reanchor_missing_quote_is_null", () => {
    expect(reanchor(t({}), text({}, 10), fh(1, 10))).toBeNull();
  });
  it("reanchor_not_commentable_is_null", () => {
    expect(reanchor(t({}), text({ 5: "  foo();" }, 10), fh(8, 3))).toBeNull();
  });
});
