import { describe, expect, it } from "vitest";
import { chapterOf, fillQuotes, mergeVerdicts, normalizeFind, placeFinding } from "./result";
import type { AiFinding, AiResult } from "./types";
import type { FileHunks } from "../types";

const files: FileHunks[] = [
  { path: "a.ts", oldPath: null, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }] },
  { path: "b.ts", oldPath: null, hunks: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 }] },
  { path: "c.ts", oldPath: null, hunks: [] },
];
const ev = [{ path: "a.ts", line: 2, quote: "q" }];
const finding = (o: Partial<{ path: string; evidence: unknown[] }> = {}) => ({
  path: "a.ts", side: "RIGHT", line: 2, startLine: null, severity: "high", body: "b", evidence: ev, ...o,
});

describe("normalizeFind", () => {
  it("rejects a non-object", () => {
    expect(() => normalizeFind("x", files)).toThrow(/^Error: ai-malformed|ai-malformed/);
    expect(() => normalizeFind(null, files)).toThrow(/ai-malformed/);
  });
  it("rejects missing chapters", () => {
    expect(() => normalizeFind({ findings: [] }, files)).toThrow(/ai-malformed/);
  });
  it("drops unknown paths and duplicates, appends Other", () => {
    const r = normalizeFind({
      chapters: [
        { title: "One", summary: "s", paths: ["a.ts", "zzz.ts", "a.ts"] },
        { title: "Two", summary: "s", paths: ["a.ts", "ghost.ts"] },
      ], findings: [],
    }, files);
    expect(r.chapters).toEqual([
      { title: "One", summary: "s", paths: ["a.ts"] },
      { title: "Other", summary: "", paths: ["b.ts", "c.ts"] },
    ]);
  });
  it("drops candidates without evidence", () => {
    const r = normalizeFind({ chapters: [], findings: [finding(), finding({ evidence: [] })] }, files);
    expect(r.candidates).toHaveLength(1);
  });
  it("drops candidates whose path and evidence are both outside the PR", () => {
    const outside = [{ path: "q.ts", line: 1, quote: "q" }];
    const r = normalizeFind({ chapters: [], findings: [
      finding({ path: "q.ts", evidence: outside }),
      finding({ path: "q.ts", evidence: ev }),
    ] }, files);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].evidence).toEqual(ev);
  });
});

describe("mergeVerdicts", () => {
  const cands = [0, 1, 2, 3].map((i) => ({ ...finding(), evidence: ev, side: "RIGHT" as const, severity: "high" as const, line: i + 1 }));
  it("keeps confirmed and unconfirmed, drops refuted and missing", () => {
    const out = mergeVerdicts(cands, { verdicts: [
      { index: 0, verdict: "confirmed", reason: "", evidence: [{ path: "b.ts", line: 1, quote: "z" }] },
      { index: 1, verdict: "refuted", reason: "", evidence: [] },
      { index: 2, verdict: "unconfirmed", reason: "", evidence: [] },
    ] });
    expect(out.map((f) => [f.id, f.status])).toEqual([["f0", "confirmed"], ["f1", "unconfirmed"]]);
    expect(out[0].evidence).toHaveLength(2);
    expect(out[0].quote).toEqual([]);
  });
});

describe("fillQuotes", () => {
  const f = (o: Partial<AiFinding>): AiFinding => ({ id: "f0", path: "a.ts", side: "RIGHT", line: 3, startLine: 2, severity: "low", body: "", evidence: [], status: "confirmed", quote: [], ...o });
  it("takes the range lines and drops out-of-range", () => {
    const texts = new Map([["a.ts|RIGHT", "l1\nl2\nl3\nl4"]]);
    const out = fillQuotes([f({}), f({ id: "f1", startLine: null, line: 4 }), f({ id: "f2", line: 9 }), f({ id: "f3", side: "LEFT" })], texts);
    expect(out.map((x) => [x.id, x.quote])).toEqual([["f0", ["l2", "l3"]], ["f1", ["l4"]]]);
  });
});

describe("placeFinding", () => {
  const f = (o: Partial<AiFinding>): AiFinding => ({ id: "f0", path: "a.ts", side: "RIGHT", line: 2, startLine: null, severity: "low", body: "", evidence: [], status: "confirmed", quote: ["x"], ...o });
  it("returns line / file / body", () => {
    expect(placeFinding(f({}), files)).toEqual({ kind: "line", path: "a.ts", side: "RIGHT", line: 2, startLine: null, quote: ["x"] });
    expect(placeFinding(f({ line: 50 }), files)).toEqual({ kind: "file", path: "a.ts", location: "a.ts:50" });
    expect(placeFinding(f({ path: "z.ts" }), files)).toEqual({ kind: "body", location: "z.ts:2" });
  });
});

describe("chapterOf", () => {
  it("finds the chapter for a path", () => {
    const r = { chapters: [{ title: "A", summary: "", paths: ["a.ts"] }, { title: "B", summary: "", paths: ["b.ts"] }] } as AiResult;
    expect(chapterOf(r, "b.ts")?.title).toBe("B");
    expect(chapterOf(r, "x")).toBeNull();
  });
});
