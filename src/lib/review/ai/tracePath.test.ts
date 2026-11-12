import { describe, expect, it } from "vitest";
import { draftTrace, traceMarkdown } from "./tracePath";
import type { AiFinding, TraceStep } from "./types";

const step = (over: Partial<TraceStep> = {}): TraceStep => ({
  path: "src/a.ts", side: "RIGHT", line: 3, quote: "const x = f();", note: "x is read here", ...over,
});

describe("traceMarkdown", () => {
  it("is empty for an empty trace", () => {
    expect(traceMarkdown("anything", [])).toBe("");
  });

  it("is a collapsed details block with numbered steps and fenced quotes", () => {
    const md = traceMarkdown("A null id crashes the save", [step(), step({ path: "src/b.cpp", line: 10, quote: "int y;", note: "y" })]);
    expect(md).toBe([
      "",
      "",
      "<details><summary>A null id crashes the save</summary>",
      "",
      "1. `src/a.ts:3` — x is read here",
      "   `````ts",
      "   const x = f();",
      "   `````",
      "2. `src/b.cpp:10` — y",
      "   `````cpp",
      "   int y;",
      "   `````",
      "",
      "</details>",
    ].join("\n"));
  });

  it("HTML-escapes the summary and keeps it on one line", () => {
    const md = traceMarkdown("a < b &&\n  c > `d`", [step()]);
    expect(md).toContain("<summary>a &lt; b &amp;&amp; c &gt; `d`</summary>");
  });

  it("names the summary when there is no scenario", () => {
    expect(traceMarkdown("  ", [step()])).toContain("<summary>Failure path</summary>");
  });

  it("fences a quote with a fence longer than its longest backtick run", () => {
    const md = traceMarkdown("s", [step({ quote: "let s = ``````x``````;" })]);
    expect(md).toContain("   ```````ts\n   let s = ``````x``````;\n   ```````");
  });

  it("indents every quote line under its step and drops trailing newlines", () => {
    const md = traceMarkdown("s", [step({ path: "Makefile", quote: "a:\n\tb\n\n" })]);
    expect(md).toContain("1. `Makefile:3` — x is read here\n   `````\n   a:\n   \tb\n   `````");
  });

  it("puts a step's note on one line", () => {
    expect(traceMarkdown("s", [step({ note: "first\nsecond" })])).toContain("— first second\n");
  });
});

describe("draftTrace", () => {
  const finding = (over: Partial<AiFinding> = {}): AiFinding => ({
    id: "f0", path: "src/a.ts", side: "RIGHT", line: 3, startLine: null, severity: "high", body: "b",
    evidence: [], status: "confirmed", quote: [], failureScenario: "boom",
    verification: { reason: "r", trace: [step()] }, ...over,
  });

  it("is the failure path of a confirmed finding", () => {
    expect(draftTrace(finding())).toBe(traceMarkdown("boom", [step()]));
  });

  it("is empty for an unconfirmed finding, a checked trace or not", () => {
    expect(draftTrace(finding({ status: "unconfirmed", verification: { reason: "r", trace: [step()], problem: "step 1 not found in src/a.ts:3" } }))).toBe("");
  });

  it("is empty without a verification", () => {
    expect(draftTrace(finding({ verification: undefined }))).toBe("");
  });
});
