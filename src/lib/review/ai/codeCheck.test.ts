import { describe, expect, it, vi } from "vitest";
import { checkFindings, collapse, quoteInFile, stepFound, type Rev } from "./codeCheck";
import type { AiFinding, TraceStep } from "./types";
import type { FileHunks } from "../types";

/** Lines `const value<i> = compute(<i>);` for i = 1..12. */
const text = Array.from({ length: 12 }, (_, i) => `const value${i + 1} = compute(${i + 1});`).join("\n") + "\n";
const L = (i: number) => `const value${i} = compute(${i});`;

describe("collapse", () => {
  it("collapses whitespace runs and trims", () => {
    expect(collapse("  a\t b\r\n\n c ")).toBe("a b c");
  });
});

describe("stepFound", () => {
  it("finds the exact line", () => {
    expect(stepFound(text, 5, L(5))).toBe(true);
  });
  it("ignores whitespace differences, CRLF included", () => {
    expect(stepFound(text, 5, "const  value5 =\n\tcompute(5);")).toBe(true);
    expect(stepFound(text.replace(/\n/g, "\r\n"), 5, L(5))).toBe(true);
  });
  it("accepts a line off by up to 3, not by 4", () => {
    expect(stepFound(text, 8, L(5))).toBe(true);
    expect(stepFound(text, 2, L(5))).toBe(true);
    expect(stepFound(text, 9, L(5))).toBe(false);
    expect(stepFound(text, 1, L(5))).toBe(false);
  });
  it("a quote over several lines may run past the window by its own length", () => {
    expect(stepFound(text, 5, [5, 6, 7, 8, 9, 10].map(L).join("\n"))).toBe(true);
    expect(stepFound(text, 5, [9, 10].map(L).join("\n"))).toBe(false);
  });
  it("needs at least 8 non-space characters", () => {
    expect(stepFound(text, 5, "mpute(5)")).toBe(true);
    expect(stepFound(text, 5, "pute(5)")).toBe(false);
    expect(stepFound(text, 5, " \n ")).toBe(false);
  });
  it("fails for a quote not there or a line past the end", () => {
    expect(stepFound(text, 5, "const value5 = compute(6);")).toBe(false);
    expect(stepFound(text, 40, L(12))).toBe(false);
  });
});

describe("quoteInFile", () => {
  it("finds a whitespace-collapsed quote anywhere", () => {
    expect(quoteInFile(text, `${L(1)}\n   ${L(2)}`)).toBe(true);
    expect(quoteInFile(text, "compute(99)")).toBe(false);
  });
  it("an empty quote proves nothing", () => {
    expect(quoteInFile(text, "  ")).toBe(false);
  });
});

describe("checkFindings", () => {
  const files: FileHunks[] = [
    { path: "a.ts", oldPath: null, hunks: [] },
    { path: "new.ts", oldPath: "old.ts", hunks: [] },
  ];
  /** head: a.ts and new.ts; mergeBase: a.ts (other text) and old.ts. */
  const repo: Record<string, string> = {
    "head|a.ts": text,
    "mergeBase|a.ts": "let gone = removed();\n",
    "head|new.ts": "renamed head code here\n",
    "mergeBase|old.ts": "renamed base code here\n",
    "head|b.ts": "b at head only\n",
    "head|c.ts": "c at head only\n",
  };
  const reader = () => vi.fn(async (rev: Rev, path: string) => {
    const t = repo[`${rev}|${path}`];
    if (t === undefined) throw new Error("missing");
    return t;
  });
  const step = (o: Partial<TraceStep> = {}): TraceStep => ({ path: "a.ts", side: "RIGHT", line: 5, quote: L(5), note: "n", ...o });
  const f = (o: Partial<AiFinding> = {}): AiFinding => ({
    id: "f0", path: "a.ts", side: "RIGHT", line: 5, startLine: null, severity: "high", body: "b",
    evidence: [{ path: "a.ts", line: 5, quote: L(5) }], status: "confirmed", quote: [],
    verification: { reason: "real", trace: [step(), step({ line: 7, quote: L(7) })] }, ...o,
  });
  const e = (path: string, quote: string) => ({ path, line: null, quote });

  it("keeps a finding whose evidence and trace check out", async () => {
    const read = reader();
    expect(await checkFindings([f()], files, read)).toEqual([f()]);
    expect(read).toHaveBeenCalledWith("head", "a.ts");
  });

  it("keeps evidence found at head or at the merge-base (old path for a rename), drops the rest", async () => {
    const roblox = e("roblox:classes/BasePart.yaml", "not checked here");
    const kept = [e("a.ts", L(3)), e("a.ts", "removed()"), e("new.ts", "renamed base code"), e("old.ts", "renamed base code"), roblox];
    const dropped = [e("a.ts", "compute(99)"), e("nope.ts", "anything at all"), e("a.ts", "")];
    const read = reader();
    const [out] = await checkFindings([f({ evidence: [...kept, ...dropped] })], files, read);
    expect(out.evidence).toEqual(kept);
    expect(out.status).toBe("confirmed");
    expect(read).not.toHaveBeenCalledWith(expect.anything(), "roblox:classes/BasePart.yaml");
    expect(read).toHaveBeenCalledWith("mergeBase", "old.ts");
  });

  it("a finding left with no evidence is unconfirmed; one with only Roblox evidence is left to the Roblox check", async () => {
    const [none, rbx] = await checkFindings([
      f({ evidence: [e("a.ts", "compute(99)")] }),
      f({ evidence: [e("roblox:classes/BasePart.yaml", "q")] }),
    ], files, reader());
    expect(none.evidence).toEqual([]);
    expect(none.status).toBe("unconfirmed");
    expect(none.verification).toEqual({ ...f().verification, problem: "evidence not found in the code" });
    expect(rbx.status).toBe("confirmed");
  });

  it("a confirmed finding with no failure path is unconfirmed; an unconfirmed one needs none", async () => {
    const out = await checkFindings([
      f({ verification: { reason: "r", trace: [] } }),
      f({ verification: undefined }),
      f({ status: "unconfirmed", verification: { reason: "r", trace: [] } }),
    ], files, reader());
    expect(out.map((x) => [x.status, x.verification])).toEqual([
      ["unconfirmed", { reason: "r", trace: [], problem: "no failure path" }],
      ["unconfirmed", { reason: "", trace: [], problem: "no failure path" }],
      ["unconfirmed", { reason: "r", trace: [] }],
    ]);
  });

  it("names the first step that fails; LEFT steps read the merge-base (old path for a rename)", async () => {
    const left = step({ path: "new.ts", side: "LEFT", line: 1, quote: "renamed base code here" });
    const cases: [TraceStep[], string | undefined][] = [
      [[step(), left], undefined],
      [[step(), step({ line: 9 }), step({ quote: "nowhere to be found" })], "step 2 not found in a.ts:9"],
      [[step({ side: "LEFT" })], "step 1 not found in a.ts:5"],
      [[step({ path: "nope.ts" })], "step 1 not found in nope.ts:5"],
      [[step(), step({ path: "roblox:classes/BasePart.yaml", quote: "name: BasePart description" })],
        "step 2 not found in roblox:classes/BasePart.yaml:5"],
    ];
    for (const [trace, problem] of cases) {
      const [out] = await checkFindings([f({ verification: { reason: "r", trace } })], files, reader());
      expect([out.status, out.verification?.problem], problem).toEqual([problem ? "unconfirmed" : "confirmed", problem]);
    }
  });

  it("checks the trace of an unconfirmed finding too, and keeps an earlier problem", async () => {
    const bad = { reason: "r", trace: [step({ quote: "nowhere to be found" })] };
    const out = await checkFindings([
      f({ status: "unconfirmed", verification: bad }),
      f({ status: "unconfirmed", verification: { ...bad, problem: "no checked Roblox reference quote" } }),
    ], files, reader());
    expect(out.map((x) => x.verification?.problem)).toEqual(["step 1 not found in a.ts:5", "no checked Roblox reference quote"]);
  });

  it("reads each file once and at most `maxFiles` files; beyond that nothing is downgraded", async () => {
    const read = reader();
    const out = await checkFindings([
      f(),
      f({ id: "f1", evidence: [e("b.ts", "wrong quote"), e("c.ts", "wrong quote")],
        verification: { reason: "r", trace: [step({ path: "c.ts", quote: "wrong quote" })] } }),
    ], files, read, 3);
    expect(read.mock.calls).toEqual([["head", "a.ts"], ["mergeBase", "a.ts"], ["head", "b.ts"]]);
    // b.ts: not at head, merge-base unread; c.ts: unread.
    expect(out[1].evidence).toHaveLength(2);
    expect(out[1].status).toBe("confirmed");
    expect(out[0]).toEqual(f());
  });
});
