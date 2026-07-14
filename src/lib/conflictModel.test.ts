import { describe, it, expect } from "vitest";
import { parseConflicts, type Segment } from "./conflictModel";

const MERGE = `line 1
<<<<<<< HEAD
current A
=======
incoming A
>>>>>>> feature
line 2
`;

const DIFF3 = `<<<<<<< HEAD
current A
||||||| base
base A
=======
incoming A
>>>>>>> feature
`;

function conflicts(segs: Segment[]) {
  return segs.filter((s) => s.type === "conflict");
}

describe("parseConflicts", () => {
  it("returns a single text segment when there are no conflicts", () => {
    const segs = parseConflicts("a\nb\n");
    expect(segs).toEqual([{ type: "text", content: "a\nb\n" }]);
  });

  it("splits leading/trailing text around a conflict", () => {
    const segs = parseConflicts(MERGE);
    expect(segs[0]).toEqual({ type: "text", content: "line 1\n" });
    expect(segs[2]).toEqual({ type: "text", content: "line 2\n" });
    expect(conflicts(segs)).toHaveLength(1);
  });

  it("captures current/incoming with no base for a plain merge", () => {
    const h = conflicts(parseConflicts(MERGE))[0];
    if (h.type !== "conflict") throw new Error("expected conflict");
    expect(h.hunk.current).toBe("current A\n");
    expect(h.hunk.incoming).toBe("incoming A\n");
    expect(h.hunk.base).toBe("");
    expect(h.hunk.choice).toBeNull();
  });

  it("captures base for a diff3 conflict", () => {
    const h = conflicts(parseConflicts(DIFF3))[0];
    if (h.type !== "conflict") throw new Error("expected conflict");
    expect(h.hunk.base).toBe("base A\n");
    expect(h.hunk.current).toBe("current A\n");
    expect(h.hunk.incoming).toBe("incoming A\n");
  });

  it("parses multiple conflicts", () => {
    const doc = MERGE + MERGE;
    expect(conflicts(parseConflicts(doc))).toHaveLength(2);
  });

  it("ignores marker words that are not at line start", () => {
    const segs = parseConflicts("a <<<<<<< not a marker\nb\n");
    expect(segs).toEqual([{ type: "text", content: "a <<<<<<< not a marker\nb\n" }]);
  });

  it("round-trips content: concatenating raw pieces reproduces the input", () => {
    const segs = parseConflicts(DIFF3);
    const raw = segs
      .map((s) =>
        s.type === "text"
          ? s.content
          : `<<<<<<< HEAD\n${s.hunk.current}||||||| base\n${s.hunk.base}=======\n${s.hunk.incoming}>>>>>>> feature\n`,
      )
      .join("");
    expect(raw).toBe(DIFF3);
  });
});
