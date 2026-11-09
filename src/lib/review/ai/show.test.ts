import { describe, expect, it } from "vitest";
import { applyHandled, chaptersFor, findingsToShow } from "./result";
import type { AiFinding, AiResult } from "./types";
import type { FileHunks } from "../types";

const files: FileHunks[] = [
  { path: "a.ts", oldPath: null, hunks: [{ oldStart: 1, oldLines: 10, newStart: 1, newLines: 10 }] },
  { path: "b.ts", oldPath: null, hunks: [{ oldStart: 20, oldLines: 2, newStart: 20, newLines: 2 }] },
];
const f = (id: string, o: Partial<AiFinding> = {}): AiFinding => ({
  id, path: "a.ts", side: "RIGHT", line: 3, startLine: null, severity: "high", body: id,
  evidence: [{ path: "a.ts", line: 3, quote: "q" }], status: "confirmed", quote: ["  foo();"], ...o,
});
const result = (findings: AiFinding[], o: Partial<AiResult> = {}): AiResult => ({
  version: 1, key: "k", headSha: "h1", baseSha: "b", mergeBase: "m", createdAt: "t",
  chapters: [], findings, handled: {}, ...o,
});
const ids = (xs: AiFinding[]) => xs.map((x) => x.id);

describe("findingsToShow", () => {
  it("findingsToShow splits inline / offDiff / unconfirmed", () => {
    const r = result([
      f("f0"),                                   // on a hunk line
      f("f1", { path: "b.ts", line: 5 }),        // in the PR, off the hunks
      f("f2", { path: "zzz.ts" }),               // outside the PR
      f("f3", { status: "unconfirmed" }),
    ]);
    const s = findingsToShow(r, "h1", files);
    expect(ids(s.inline)).toEqual(["f0"]);
    expect(ids(s.offDiff)).toEqual(["f1", "f2"]);
    expect(ids(s.unconfirmed)).toEqual(["f3"]);
    expect(s.stale).toBe(false);
    expect(s.inline[0].target).toEqual({ kind: "line", path: "a.ts", side: "RIGHT", line: 3, startLine: null, quote: ["  foo();"] });
    expect(s.offDiff.map((x) => x.target.kind)).toEqual(["file", "body"]);
  });

  it("handled findings are hidden", () => {
    const r = result([f("f0"), f("f1"), f("f2", { status: "unconfirmed" })], { handled: { f0: "added", f2: "discarded" } });
    const s = findingsToShow(r, "h1", files);
    expect(ids(s.inline)).toEqual(["f1"]);
    expect(s.unconfirmed).toEqual([]);
  });

  it("stale result re-places by quote and moves unplaceable to offDiff", () => {
    const r = result([
      f("f0"),                                   // quote moved from 3 to 6
      f("f1", { quote: ["gone();"] }),           // quote no longer in the file
      f("f2", { path: "b.ts", line: 20 }),       // no text loaded for b.ts
      f("f3", { status: "unconfirmed" }),
    ]);
    const text = ["x1", "x2", "x3", "x4", "x5", "  foo();", "x7"].join("\n");
    const s = findingsToShow(r, "h2", files, new Map([["a.ts|RIGHT", text]]));
    expect(s.stale).toBe(true);
    expect(ids(s.inline)).toEqual(["f0"]);
    expect(s.inline[0].target).toMatchObject({ kind: "line", line: 6, startLine: null });
    expect(ids(s.offDiff)).toEqual(["f1", "f2"]);
    // Unplaceable on a stale head: never a line comment at the old line.
    expect(s.offDiff.map((x) => x.target)).toEqual([
      { kind: "file", path: "a.ts", location: "a.ts:3" },
      { kind: "file", path: "b.ts", location: "b.ts:20" },
    ]);
    expect(s.unconfirmed[0].target).toMatchObject({ kind: "line", line: 6 });
  });

  it("no result shows nothing", () => {
    expect(findingsToShow(null, "h1", files)).toEqual({ inline: [], offDiff: [], unconfirmed: [], stale: false });
  });
});

describe("chaptersFor", () => {
  it("keeps current paths and puts new files under Other", () => {
    const r = result([], { chapters: [{ title: "A", summary: "s", paths: ["gone.ts", "b.ts"] }, { title: "B", summary: "", paths: ["gone2.ts"] }] });
    expect(chaptersFor(r, files)).toEqual([
      { title: "A", summary: "s", paths: ["b.ts"] },
      { title: "Other", summary: "", paths: ["a.ts"] },
    ]);
  });
});

describe("applyHandled", () => {
  it("marks the finding on the expected result", () => {
    const r = result([f("f0")], { createdAt: "t1" });
    expect(applyHandled(r, "t1", "f0", "added")?.handled).toEqual({ f0: "added" });
    expect(r.handled).toEqual({});
  });
  it("does nothing on a newer result, a missing result or an unchanged mark", () => {
    const r = result([f("f0")], { createdAt: "t2" });
    expect(applyHandled(r, "t1", "f0", "added")).toBeNull();
    expect(applyHandled(null, "t1", "f0", "added")).toBeNull();
    expect(applyHandled(result([f("f0")], { createdAt: "t1", handled: { f0: "added" } }), "t1", "f0", "added")).toBeNull();
  });
});
