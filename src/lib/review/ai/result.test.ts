import { describe, expect, it } from "vitest";
import { chapterOf, fillQuotes, mergeVerdicts, normalizeFind, normalizeRoblox, placeFinding } from "./result";
import type { AiFinding, AiResult } from "./types";
import type { FileHunks } from "../types";

const files: FileHunks[] = [
  { path: "a.ts", oldPath: null, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }] },
  { path: "b.ts", oldPath: null, hunks: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 }] },
  { path: "c.ts", oldPath: null, hunks: [] },
];
const ev = [{ path: "a.ts", line: 2, quote: "q" }];
const finding = (o: Partial<{ path: string; evidence: unknown[]; failureScenario: string }> = {}) => ({
  path: "a.ts", side: "RIGHT", line: 2, startLine: null, severity: "high", body: "b", evidence: ev,
  failureScenario: "x = null → crash", ...o,
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
  it("drops candidates with no failure scenario and keeps the scenario on the rest", () => {
    const r = normalizeFind({ chapters: [], findings: [
      finding({ failureScenario: "" }), finding({ failureScenario: "  \n" }), finding({ failureScenario: 3 } as never),
      { ...finding(), failureScenario: undefined }, finding({ failureScenario: " empty list → index -1 read " }),
    ] }, files);
    expect(r.candidates.map((c) => c.failureScenario)).toEqual(["empty list → index -1 read"]);
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
  const step = { path: "a.ts", side: "RIGHT", line: 2, quote: "const x = y;", note: "n" };
  it("keeps confirmed and unconfirmed, drops refuted and missing", () => {
    const { findings: out } = mergeVerdicts(cands, { verdicts: [
      { index: 0, verdict: "confirmed", reason: "", evidence: [{ path: "b.ts", line: 1, quote: "z" }], trace: [] },
      { index: 1, verdict: "refuted", reason: "", evidence: [], trace: [] },
      { index: 2, verdict: "unconfirmed", reason: "", evidence: [], trace: [] },
    ] });
    expect(out.map((f) => [f.id, f.status])).toEqual([["f0", "confirmed"], ["f1", "unconfirmed"]]);
    expect(out[0].evidence).toHaveLength(2);
    expect(out[0].quote).toEqual([]);
  });
  it("keeps the verifier's reason, and the trace of a confirmed verdict", () => {
    const { findings: out } = mergeVerdicts(cands, { verdicts: [
      { index: 0, verdict: "confirmed", reason: "real", evidence: [], trace: [step, { ...step, side: "LEFT", line: 9 }] },
      { index: 1, verdict: "unconfirmed", reason: "unsure", evidence: [], trace: [step] },
      { index: 2, verdict: "confirmed", evidence: [] },
    ] });
    expect(out.map((f) => f.verification)).toEqual([
      { reason: "real", trace: [step, { ...step, side: "LEFT", line: 9 }] },
      { reason: "unsure", trace: [] },
      { reason: "", trace: [] },
    ]);
  });
  it("a trace with a malformed step counts as none", () => {
    for (const bad of [{ ...step, side: "UP" }, { ...step, line: 0 }, { ...step, line: 1.5 }, { ...step, quote: 1 }, { ...step, note: null }, "x"]) {
      const { findings: [f] } = mergeVerdicts(cands, { verdicts: [{ index: 0, verdict: "confirmed", reason: "r", evidence: [], trace: [step, bad] }] });
      expect(f.verification?.trace, JSON.stringify(bad)).toEqual([]);
    }
  });
  it("returns the refuted candidates with the first body line and the reason", () => {
    const { refuted } = mergeVerdicts(
      [{ ...cands[0], body: "\n  \r\n  First line  \nsecond" },{ ...cands[1], severity: "low" as const, body: "" }, cands[2]],
      { verdicts: [
        { index: 0, verdict: "refuted", reason: "guarded above", evidence: [], trace: [] },
        { index: 1, verdict: "refuted", evidence: [], trace: [] },
        { index: 2, verdict: "confirmed", reason: "r", evidence: [], trace: [] },
      ] });
    expect(refuted).toEqual([
      { path: "a.ts", line: 1, severity: "high", summary: "First line", reason: "guarded above" },
      { path: "a.ts", line: 2, severity: "low", summary: "", reason: "" },
    ]);
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

describe("tolerant normalization", () => {
  it("one invalid finding is dropped, others kept", () => {
    const r = normalizeFind({ chapters: [], findings: [finding({ side: "MIDDLE" } as never), finding({ body: 5 } as never), finding()] }, files);
    expect(r.candidates).toHaveLength(1);
  });
  it("invalid chapter dropped", () => {
    const r = normalizeFind({ chapters: [{ title: 3, summary: "", paths: ["a.ts"] }, "junk", { title: "T", summary: "", paths: ["b.ts"] }], findings: [] }, files);
    expect(r.chapters.map((c) => c.title)).toEqual(["T", "Other"]);
    expect(r.chapters[1].paths).toEqual(["a.ts", "c.ts"]);
  });
});

describe("fillQuotes line endings", () => {
  const f: AiFinding = { id: "f0", path: "a.ts", side: "RIGHT", line: 3, startLine: null, severity: "low", body: "", evidence: [], status: "confirmed", quote: [] };
  it("drops a line past a trailing newline", () => {
    expect(fillQuotes([f], new Map([["a.ts|RIGHT", "1\n2\n3\n"]]))[0].quote).toEqual(["3"]);
    expect(fillQuotes([{ ...f, line: 4 }], new Map([["a.ts|RIGHT", "1\n2\n3\n"]]))).toEqual([]);
  });
  it("strips CR from CRLF text", () => {
    expect(fillQuotes([{ ...f, startLine: 2 }], new Map([["a.ts|RIGHT", "1\r\n2\r\n3\r\n"]]))[0].quote).toEqual(["2", "3"]);
  });
});

describe("normalizeRoblox", () => {
  it("rejects an answer without findings", () => {
    expect(() => normalizeRoblox({}, files)).toThrow(/ai-malformed/);
    expect(() => normalizeRoblox(null, files)).toThrow(/ai-malformed/);
  });
  it("keeps the candidates normalizeFind would, tagged roblox", () => {
    const r = normalizeRoblox({ findings: [finding(), finding({ failureScenario: "" }), finding({ evidence: [] })] }, files);
    expect(r).toHaveLength(1);
    expect(r[0].tag).toBe("roblox");
    expect(r[0].failureScenario).toBe("x = null → crash");
  });
  it("the tag goes through verify", () => {
    const [c] = normalizeRoblox({ findings: [finding()] }, files);
    const { findings: out } = mergeVerdicts([c], { verdicts: [{ index: 0, verdict: "confirmed", reason: "", evidence: [], trace: [] }] });
    expect(out[0].tag).toBe("roblox");
  });
});
