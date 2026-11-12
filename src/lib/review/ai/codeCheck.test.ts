import { describe, expect, it, vi } from "vitest";
import { checkFindings, collapse, quoteInFile, stepLine, type Rev } from "./codeCheck";
import type { AiFinding, TraceStep } from "./types";
import type { FileHunks } from "../types";

/** Lines `const value<i> = compute(<i>);` for i = 1..12. */
const text = Array.from({ length: 12 }, (_, i) => `const value${i + 1} = compute(${i + 1});`).join("\n") + "\n";
const L = (i: number) => `const value${i} = compute(${i});`;

describe("collapse", () => {
  it("collapses whitespace runs and trims", () => {
    expect(collapse("  a\t b\r\n\n c ")).toBe("a b c");
    expect(collapse("a� � b")).toBe("a b");
  });
});

describe("stepLine", () => {
  /** Lines 1..12 as `text`, then line 13 repeating line 2: `L(2)` is in it twice. */
  const twice = `${text}${L(2)}\n`;
  it("finds the exact line", () => {
    expect(stepLine(text, 5, L(5))).toBe(5);
  });
  it("ignores whitespace differences, CRLF included", () => {
    expect(stepLine(text, 5, "const  value5 =\n\tcompute(5);")).toBe(5);
    expect(stepLine(text.replace(/\n/g, "\r\n"), 5, L(5))).toBe(5);
  });
  it("accepts a line off by up to 3 as given", () => {
    expect(stepLine(text, 8, L(5))).toBe(8);
    expect(stepLine(text, 2, L(5))).toBe(2);
  });
  it("outside the window, takes the quote's line when it is in the file once", () => {
    expect(stepLine(text, 9, L(5))).toBe(5);
    expect(stepLine(text, 1, L(5))).toBe(5);
    expect(stepLine(text, 40, L(12))).toBe(12);
    expect(stepLine(text, 1, `${L(10)}\n${L(11)}`)).toBe(10);
    expect(stepLine(text, 1, "value10 = compute")).toBe(10);
  });
  it("outside the window, fails when the quote is in the file more than once", () => {
    expect(stepLine(twice, 9, L(2))).toBeNull();
    expect(stepLine(twice, 3, L(2))).toBe(3);
  });
  it("a quote over several lines may run past the window by its own length", () => {
    const run = [5, 6, 7, 8, 9, 10].map(L).join("\n");
    expect(stepLine(text, 5, run)).toBe(5);
    expect(stepLine(twice, 5, [9, 10].map(L).join("\n"))).toBe(9);
  });
  it("needs at least 8 non-space characters", () => {
    expect(stepLine(text, 5, "mpute(5)")).toBe(5);
    expect(stepLine(text, 5, "pute(5)")).toBeNull();
    expect(stepLine(text, 5, " \n ")).toBeNull();
  });
  it("fails for a quote not there", () => {
    expect(stepLine(text, 5, "const value5 = compute(6);")).toBeNull();
  });
  it("retries without diff markers when every quote line has one", () => {
    expect(stepLine(text, 5, `+${L(5)}`)).toBe(5);
    expect(stepLine(text, 5, `-${L(5)}\n+${L(6)}\n\n ${L(7)}`)).toBe(5);
    expect(stepLine(text, 5, `+${L(5)}\n${L(6)}`)).toBeNull();
  });
  it("ignores U+FFFD on both sides (lossily decoded non-UTF-8 text)", () => {
    const lossy = text.replace("value5", "val��ue5");
    expect(stepLine(lossy, 5, L(5))).toBe(5);
    expect(stepLine(text, 5, "const �value5 = compute(5);")).toBe(5);
  });
});

describe("quoteInFile", () => {
  it("finds a whitespace-collapsed quote anywhere", () => {
    expect(quoteInFile(text, `${L(1)}\n   ${L(2)}`)).toBe(true);
    expect(quoteInFile(text, "compute(99)")).toBe(false);
  });
  it("needs at least 8 non-space characters", () => {
    expect(quoteInFile(text, "  ")).toBe(false);
    expect(quoteInFile(text, "pute(5)")).toBe(false);
    expect(quoteInFile(text, "mpute(5)")).toBe(true);
  });
  it("retries without diff markers, and ignores U+FFFD", () => {
    expect(quoteInFile(text, `+  ${L(3)}\n-${L(4)}`)).toBe(true);
    expect(quoteInFile(text.replace("value3", "value3�"), L(3))).toBe(true);
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
  /** Rejects like the app's read_file_at: git's message for a missing path, riff's for a big file. */
  const reader = () => vi.fn(async (rev: Rev, path: string) => {
    if (path === "big.ts") throw "git command failed: file too large for blame view (2000001 bytes)";
    const t = repo[`${rev}|${path}`];
    if (t === undefined) throw `git command failed: fatal: path '${path}' does not exist in '${rev}'`;
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
    const kept = [e("a.ts", L(3)), e("a.ts", "removed()"), e("new.ts", "renamed base code"), e("old.ts", "renamed base code"),
      e("a.ts", `+ ${L(4)}`), roblox];
    const dropped = [e("a.ts", "compute(99)"), e("nope.ts", "anything at all"), e("a.ts", ""), e("a.ts", "value3")];
    const read = reader();
    const [out] = await checkFindings([f({ evidence: [...kept, ...dropped] })], files, read);
    expect(out.evidence).toEqual(kept);
    expect(out.status).toBe("confirmed");
    expect(read).not.toHaveBeenCalledWith(expect.anything(), "roblox:classes/BasePart.yaml");
    expect(read).toHaveBeenCalledWith("mergeBase", "old.ts");
  });

  it("reads a file the PR does not change at head only, for evidence and LEFT steps alike", async () => {
    const read = reader();
    const trace = [step(), step({ path: "b.ts", side: "LEFT", line: 1, quote: "b at head only" })];
    const [out] = await checkFindings([f({ evidence: [e("b.ts", "b at head only")], verification: { reason: "r", trace } })], files, read);
    expect(out.status).toBe("confirmed");
    expect(out.evidence).toEqual([e("b.ts", "b at head only")]);
    expect(read.mock.calls.filter(([, p]) => p === "b.ts")).toEqual([["head", "b.ts"]]);
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

  it("a confirmed finding needs a failure path of 2 to 8 steps; an unconfirmed one needs none", async () => {
    const nine = Array.from({ length: 9 }, () => step());
    const out = await checkFindings([
      f({ verification: { reason: "r", trace: [] } }),
      f({ verification: undefined }),
      f({ status: "unconfirmed", verification: { reason: "r", trace: [] } }),
      f({ verification: { reason: "r", trace: [step()] } }),
      f({ verification: { reason: "r", trace: nine.slice(1) } }),
      f({ verification: { reason: "r", trace: nine } }),
    ], files, reader());
    expect(out.map((x) => [x.status, x.verification])).toEqual([
      ["unconfirmed", { reason: "r", trace: [], problem: "no failure path" }],
      ["unconfirmed", { reason: "", trace: [], problem: "no failure path" }],
      ["unconfirmed", { reason: "r", trace: [] }],
      ["unconfirmed", { reason: "r", trace: [step()], problem: "no failure path" }],
      ["confirmed", { reason: "r", trace: nine.slice(1) }],
      ["unconfirmed", { reason: "r", trace: nine, problem: "failure path longer than 8 steps" }],
    ]);
  });

  it("names the first step that fails; LEFT steps read the merge-base (old path for a rename)", async () => {
    const left = step({ path: "new.ts", side: "LEFT", line: 1, quote: "renamed base code here" });
    const cases: [TraceStep[], string | undefined][] = [
      [[step(), left], undefined],
      [[step(), step({ line: 9, quote: "nowhere to be found" }), step({ quote: "nor here at all" })], "step 2 not found in a.ts:9"],
      [[step(), step({ side: "LEFT" })], "step 2 not found in a.ts:5"],
      [[step(), step({ path: "nope.ts" })], "step 2 not found in nope.ts:5"],
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

  it("moves a step outside the window to the one line its quote is on", async () => {
    const trace = [step({ line: 11 }), step({ line: 1, quote: `+ ${L(9)}` })];
    const [out] = await checkFindings([f({ verification: { reason: "r", trace } })], files, reader());
    expect(out.status).toBe("confirmed");
    expect(out.verification?.trace.map((s) => [s.line, s.quote])).toEqual([[5, L(5)], [9, `+ ${L(9)}`]]);
  });

  it("reads each file once and at most `maxFiles` files, trace steps first", async () => {
    const read = reader();
    const f1 = f({ id: "f1", evidence: [e("b.ts", "wrong quote"), e("c.ts", "wrong quote")],
      verification: { reason: "r", trace: [step(), step({ path: "c.ts", quote: "wrong quote" })] } });
    const out = await checkFindings([f(), f1], files, read, 2);
    expect(read.mock.calls).toEqual([["head", "a.ts"], ["head", "c.ts"]]);
    expect(out[1].verification?.problem).toBe("step 2 not found in c.ts:5");
    expect(out[0]).toEqual(f());
  });

  it("a confirmed finding with a step past the cap stays confirmed, marked unchecked; unread evidence is kept", async () => {
    const read = reader();
    const f1 = f({ id: "f1", evidence: [e("b.ts", "wrong quote"), e("c.ts", "wrong quote")],
      verification: { reason: "r", trace: [step(), step({ path: "c.ts", quote: "wrong quote" })] } });
    const out = await checkFindings([f(), f1], files, read, 1);
    expect(read.mock.calls).toEqual([["head", "a.ts"]]);
    expect(out[1].status).toBe("confirmed");
    expect(out[1].evidence).toHaveLength(2);
    expect(out[1].verification).toEqual({ ...f1.verification, unchecked: true });
    expect(out[0]).toEqual(f());
  });

  it("a file too large to read leaves its steps unchecked, not failed; a missing file fails them", async () => {
    const big = [step(), step({ path: "big.ts", quote: "anything here" })];
    const out = await checkFindings([
      f({ evidence: [e("big.ts", "anything here")], verification: { reason: "r", trace: big } }),
      f({ status: "unconfirmed", verification: { reason: "r", trace: big } }),
    ], files, reader());
    expect([out[0].status, out[0].evidence.length, out[0].verification]).toEqual(["confirmed", 1, { reason: "r", trace: big, unchecked: true }]);
    expect(out[1].verification).toEqual({ reason: "r", trace: big });
  });
});
