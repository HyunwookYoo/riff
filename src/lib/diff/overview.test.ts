import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import {
  chunkKind,
  currentChunkIndex,
  nextChunkIndex,
  mapAToB,
  overviewMarks,
  type ChunkSpan,
  type OverviewGeometry,
} from "./overview";

const doc = (n: number, prefix: string) =>
  Text.of(Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`));

// Each line is an equal slice of the scrolled height: line k of n spans
// [(k-1)/n, k/n]. Real geometry comes from the editor's line blocks.
function geometry(a: Text, b: Text): OverviewGeometry {
  return {
    doc: (side) => (side === "a" ? a : b),
    span: (side, pos) => {
      const d = side === "a" ? a : b;
      const n = d.lineAt(pos).number;
      return { top: (n - 1) / d.lines, bottom: n / d.lines };
    },
  };
}

// Chunk offsets in line units: lines [fromLine, toLine) of each side, as
// @codemirror/merge reports them (start of first line, one past the last).
function chunk(a: Text, b: Text, aFrom: number, aTo: number, bFrom: number, bTo: number): ChunkSpan {
  const at = (d: Text, l: number) => (l > d.lines ? d.length + 1 : d.line(l).from);
  return { fromA: at(a, aFrom), toA: at(a, aTo), fromB: at(b, bFrom), toB: at(b, bTo) };
}

describe("chunkKind", () => {
  it("names insert-only, delete-only and two-sided chunks", () => {
    expect(chunkKind({ fromA: 5, toA: 5, fromB: 5, toB: 9 })).toBe("added");
    expect(chunkKind({ fromA: 5, toA: 9, fromB: 5, toB: 5 })).toBe("deleted");
    expect(chunkKind({ fromA: 5, toA: 9, fromB: 5, toB: 7 })).toBe("modified");
  });
});

describe("overviewMarks", () => {
  // a: 10 lines. b: lines 3-4 inserted after a's line 2, a's line 6 deleted,
  // a's line 9 rewritten into two lines → b has 12 lines.
  const a = doc(10, "a");
  const b = doc(12, "b");
  const chunks = [
    chunk(a, b, 3, 3, 3, 5), // added b3-b4
    chunk(a, b, 6, 7, 8, 8), // deleted a6, sits before b8
    chunk(a, b, 9, 10, 10, 12), // modified a9 → b10-b11
  ];

  it("positions change marks on side b with percent top/height and a kind", () => {
    const marks = overviewMarks(chunks, [], geometry(a, b));
    expect(marks.map((m) => m.kind)).toEqual(["added", "deleted", "modified"]);
    expect(marks[0].top).toBeCloseTo((2 / 12) * 100);
    expect(marks[0].height).toBeCloseTo((2 / 12) * 100);
    expect(marks[0].side).toBe("b");
    expect(marks[0].pos).toBe(b.line(3).from);
  });

  it("gives a delete-only chunk zero height at its side-b position", () => {
    const [, del] = overviewMarks(chunks, [], geometry(a, b));
    expect(del.top).toBeCloseTo((7 / 12) * 100);
    expect(del.height).toBe(0);
    expect(del.pos).toBe(b.line(8).from);
  });

  it("labels each change with its line counts", () => {
    const labels = overviewMarks(chunks, [], geometry(a, b)).map((m) => m.label);
    expect(labels).toEqual(["added 2 lines", "deleted 1 line", "modified 1 → 2 lines"]);
  });

  it("handles a chunk that runs to one past the end of the document", () => {
    const a2 = doc(3, "a");
    const b2 = doc(5, "b");
    const [m] = overviewMarks([chunk(a2, b2, 4, 4, 4, 6)], [], geometry(a2, b2));
    expect(m.label).toBe("added 2 lines");
    expect(m.top + m.height).toBeCloseTo(100);
  });

  it("places markers on their own side's line and labels them", () => {
    const marks = overviewMarks(
      [],
      [
        { side: "a", line: 4, kind: "thread" },
        { side: "b", line: 12, kind: "finding" },
        { side: "b", line: 1, kind: "draft" },
      ],
      geometry(a, b),
    );
    expect(marks.map((m) => [m.kind, m.side, m.pos])).toEqual([
      ["thread", "a", a.line(4).from],
      ["finding", "b", b.line(12).from],
      ["draft", "b", 0],
    ]);
    expect(marks[0].top).toBeCloseTo(30);
    expect(marks[0].height).toBeCloseTo(10);
    expect(marks.map((m) => m.label)).toEqual(["thread · line 4", "AI finding · line 12", "draft · line 1"]);
  });

  it("clamps marker lines outside the document", () => {
    const [m] = overviewMarks([], [{ side: "b", line: 99, kind: "thread" }], geometry(a, b));
    expect(m.pos).toBe(b.line(12).from);
    expect(m.top + m.height).toBeCloseTo(100);
  });
});

describe("mapAToB", () => {
  const a = doc(10, "a");
  const b = doc(12, "b");
  const chunks = [chunk(a, b, 3, 3, 3, 5), chunk(a, b, 6, 7, 8, 8), chunk(a, b, 9, 10, 10, 12)];

  it("keeps positions before the first chunk", () => {
    expect(mapAToB(chunks, a.line(2).from)).toBe(b.line(2).from);
  });

  it("shifts unchanged lines by the preceding chunks' size difference", () => {
    expect(mapAToB(chunks, a.line(3).from)).toBe(b.line(5).from);
    expect(mapAToB(chunks, a.line(7).from)).toBe(b.line(8).from);
    expect(mapAToB(chunks, a.line(10).from)).toBe(b.line(12).from);
  });

  it("maps a line inside a chunk to the chunk's start on side b", () => {
    expect(mapAToB(chunks, a.line(6).from)).toBe(b.line(8).from);
    expect(mapAToB(chunks, a.line(9).from + 1)).toBe(b.line(10).from);
  });
});

describe("currentChunkIndex", () => {
  const chunks = [
    { fromA: 0, toA: 0, fromB: 10, toB: 20 },
    { fromA: 0, toA: 0, fromB: 50, toB: 50 }, // delete-only
    { fromA: 0, toA: 0, fromB: 80, toB: 90 },
  ];

  it("is -1 without chunks", () => {
    expect(currentChunkIndex([], 0)).toBe(-1);
  });

  it("picks the chunk at the viewport top", () => {
    expect(currentChunkIndex(chunks, 15)).toBe(0);
    expect(currentChunkIndex(chunks, 19)).toBe(0);
  });

  it("picks the first chunk below the viewport top", () => {
    expect(currentChunkIndex(chunks, 0)).toBe(0);
    expect(currentChunkIndex(chunks, 20)).toBe(1);
    expect(currentChunkIndex(chunks, 50)).toBe(1);
    expect(currentChunkIndex(chunks, 51)).toBe(2);
  });

  it("stays on the last chunk once the top is past every chunk", () => {
    expect(currentChunkIndex(chunks, 500)).toBe(2);
  });
});

describe("nextChunkIndex", () => {
  // Chunk tops in px from the document top; the viewport top is a px offset too.
  const tops = [100, 400, 900];

  it("is -1 without chunks", () => {
    expect(nextChunkIndex([], 0, 1)).toBe(-1);
    expect(nextChunkIndex([], 0, -1)).toBe(-1);
  });

  it("goes to the first chunk starting below the viewport top", () => {
    expect(nextChunkIndex(tops, 0, 1)).toBe(0);
    expect(nextChunkIndex(tops, 150, 1)).toBe(1);
    expect(nextChunkIndex(tops, 400, 1)).toBe(2); // the chunk at the top is the current one
  });

  it("goes back to the last chunk starting above the viewport top", () => {
    expect(nextChunkIndex(tops, 1000, -1)).toBe(2);
    expect(nextChunkIndex(tops, 400, -1)).toBe(0); // not the chunk at the top
    expect(nextChunkIndex(tops, 401, -1)).toBe(0); // within the epsilon
    expect(nextChunkIndex(tops, 50, -1)).toBe(-1);
  });

  it("stops at the ends", () => {
    expect(nextChunkIndex(tops, 950, 1)).toBe(-1);
  });

  it("steps from the chunk last navigated to while the view hasn't moved", () => {
    // After centring chunk 1 the viewport top sits above it: still step to 2 / 0.
    expect(nextChunkIndex(tops, 150, 1, 1)).toBe(2);
    expect(nextChunkIndex(tops, 150, -1, 1)).toBe(0);
    expect(nextChunkIndex(tops, 150, 1, 2)).toBe(-1);
    expect(nextChunkIndex(tops, 150, -1, 0)).toBe(-1);
  });
});
