import { describe, expect, it } from "vitest";
import { clickComposer, composerKey, RANGE_NOTE, type ComposerAt } from "./composerAt";
import type { FileHunks } from "$lib/review/types";

const fh: FileHunks = {
  path: "a.ts",
  oldPath: null,
  hunks: [
    { oldStart: 1, oldLines: 5, newStart: 10, newLines: 10 },
    { oldStart: 30, oldLines: 3, newStart: 40, newLines: 3 },
  ],
};
const click = (cur: ComposerAt | null, line: number, shift = false, side: "LEFT" | "RIGHT" = "RIGHT") =>
  clickComposer(cur, { path: "a.ts", side, line, shift }, fh);

describe("clickComposer", () => {
  it("opens a single-line composer", () => {
    expect(click(null, 12)).toEqual({
      composer: { path: "a.ts", side: "RIGHT", anchor: 12, line: 12, startLine: null },
      note: null,
    });
  });

  it("clicking the open composer's line again keeps the same composer", () => {
    const cur = click(null, 12).composer!;
    expect(click(cur, 12).composer).toBe(cur);
    expect(click(cur, 12, true).composer).toBe(cur);
  });

  it("shift-click extends a range from the anchor, either direction", () => {
    const cur = click(null, 12).composer!;
    const down = click(cur, 15, true).composer!;
    expect(down).toMatchObject({ anchor: 12, line: 15, startLine: 12 });
    expect(click(down, 10, true).composer).toMatchObject({ anchor: 12, line: 12, startLine: 10 });
  });

  it("shift-click back onto the anchor collapses to a single line", () => {
    const range = click(click(null, 12).composer!, 15, true).composer!;
    expect(click(range, 12, true).composer).toMatchObject({ line: 12, startLine: null });
  });

  it("rejects a range across hunks with a note and keeps the composer", () => {
    const cur = click(null, 12).composer!;
    expect(click(cur, 41, true)).toEqual({ composer: cur, note: RANGE_NOTE });
  });

  it("shift-click on the other side opens a new composer there", () => {
    const cur = click(null, 12).composer!;
    expect(click(cur, 2, true, "LEFT").composer).toEqual({
      path: "a.ts", side: "LEFT", anchor: 2, line: 2, startLine: null,
    });
  });

  it("composerKey tells path, side, start and line apart", () => {
    const base: ComposerAt = { path: "a.ts", side: "RIGHT", anchor: 3, line: 3, startLine: null };
    const keys = [
      base,
      { ...base, path: "b.ts" },
      { ...base, side: "LEFT" as const },
      { ...base, startLine: 1 },
      { ...base, line: 4 },
    ].map(composerKey);
    expect(new Set(keys).size).toBe(5);
    expect(composerKey({ ...base, anchor: 9 })).toBe(composerKey(base));
  });
});
