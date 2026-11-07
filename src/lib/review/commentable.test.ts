import { describe, it, expect } from "vitest";
import { isCommentable, placeTarget } from "./commentable";
import type { FileHunks } from "./types";

const fh: FileHunks = { path: "a.ts", oldPath: null, hunks: [{ oldStart: 3, oldLines: 7, newStart: 3, newLines: 8 }] };

describe("isCommentable", () => {
  it("RIGHT uses new range", () => {
    expect(isCommentable(fh, "RIGHT", 3)).toBe(true);
    expect(isCommentable(fh, "RIGHT", 10)).toBe(true);
    expect(isCommentable(fh, "RIGHT", 11)).toBe(false);
    expect(isCommentable(fh, "RIGHT", 2)).toBe(false);
  });
  it("LEFT uses old range", () => {
    expect(isCommentable(fh, "LEFT", 9)).toBe(true);
    expect(isCommentable(fh, "LEFT", 10)).toBe(false);
  });
  it("ranges must sit inside one hunk", () => {
    expect(isCommentable(fh, "RIGHT", 5, 2)).toBe(false);
    expect(isCommentable(fh, "RIGHT", 5, 3)).toBe(true);
    const two: FileHunks = { ...fh, hunks: [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 },
      { oldStart: 4, oldLines: 3, newStart: 4, newLines: 3 },
    ] };
    expect(isCommentable(two, "RIGHT", 5, 2)).toBe(false);
  });
  it("undefined file is false", () => {
    expect(isCommentable(undefined, "RIGHT", 3)).toBe(false);
  });
});

describe("placeTarget", () => {
  it("line / file / body", () => {
    expect(placeTarget("a.ts", "RIGHT", 4, null, [fh])).toBe("line");
    expect(placeTarget("a.ts", "RIGHT", 50, null, [fh])).toBe("file");
    expect(placeTarget("b.ts", "RIGHT", 4, null, [fh])).toBe("body");
  });
});
