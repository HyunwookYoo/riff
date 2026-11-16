import { describe, expect, it } from "vitest";
import { codeSpan, draftTrace, inert, inertProse, replyAppendix, traceMarkdown } from "./tracePath";
import type { AiFinding, ThreadCheck, TraceStep } from "./types";

const step = (over: Partial<TraceStep> = {}): TraceStep => ({
  path: "src/a.ts", side: "RIGHT", line: 3, quote: "const x = f();", note: "x is read here", ...over,
});

const WJ = "⁠";

describe("inert", () => {
  it("escapes HTML", () => {
    expect(inert("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    expect(inert("</details><summary>x")).toBe("&lt;/details&gt;&lt;summary&gt;x");
  });
  it("breaks GitHub mentions and issue references with a word joiner", () => {
    expect(inert("ask @name, see @Override")).toBe(`ask @${WJ}name, see @${WJ}Override`);
    expect(inert("fixes #12 and o/r#3")).toBe(`fixes #${WJ}12 and o/r#${WJ}3`);
    expect(inert("GH-3 and gh-4")).toBe(`GH-${WJ}3 and gh-${WJ}4`);
  });
  it("leaves a lone @ or # and other text alone", () => {
    expect(inert("a @ b, #define x, C# code, AGH-x")).toBe("a @ b, #define x, C# code, AGH-x");
  });
});

describe("inertProse", () => {
  it("is inert outside code spans and leaves them as written", () => {
    expect(inertProse("`p->x < y && z` and @Override `@Override`")).toBe(`\`p->x < y && z\` and @${WJ}Override \`@Override\``);
  });
  it("closes a span only with a run of the same length", () => {
    expect(inertProse("``a ` <b>`` <i>")).toBe("``a ` <b>`` &lt;i&gt;");
    expect(inertProse("`<a>`` <b>")).toBe("`&lt;a&gt;`` &lt;b&gt;");
  });
  it("leaves an unpaired run as prose", () => {
    expect(inertProse("a `b <c> #1")).toBe(`a \`b &lt;c&gt; #${WJ}1`);
  });
});

describe("codeSpan", () => {
  it("wraps text in backticks", () => {
    expect(codeSpan("src/a.ts:3")).toBe("`src/a.ts:3`");
  });
  it("uses a backtick run longer than any in the text, padded when it starts or ends with one", () => {
    expect(codeSpan("a`b``c.ts:3")).toBe("```a`b``c.ts:3```");
    expect(codeSpan("`x.ts:3")).toBe("`` `x.ts:3 ``");
    expect(codeSpan("x.ts`")).toBe("`` x.ts` ``");
  });
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

  it("leaves code spans in a note as written, neutralising only the prose around them", () => {
    const md = traceMarkdown("s", [step({ note: "`p->x < y && z` with @Override in ``@Override a`b`` but @dev <b> `unpaired" })]);
    expect(md).toContain(`— \`p->x < y && z\` with @${WJ}Override in \`\`@Override a\`b\`\` but @${WJ}dev &lt;b&gt; \`unpaired\n`);
  });

  it("neutralises HTML, mentions and references in the summary and the notes", () => {
    const md = traceMarkdown("@team breaks #12", [step({ note: "</details> GH-3 @Override <b>" })]);
    expect(md).toContain(`<summary>@${WJ}team breaks #${WJ}12</summary>`);
    expect(md).toContain(`— &lt;/details&gt; GH-${WJ}3 @${WJ}Override &lt;b&gt;\n`);
    expect(md.match(/<\/details>/g)).toHaveLength(1);
  });

  it("puts a path with backticks in a longer code span", () => {
    expect(traceMarkdown("s", [step({ path: "a`b.ts" })])).toContain("1. ``a`b.ts:3`` — ");
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

  it("is empty for a confirmed finding riff could not check all of", () => {
    expect(draftTrace(finding({ verification: { reason: "r", trace: [step()], unchecked: true } }))).toBe("");
  });

  it("is empty without a verification", () => {
    expect(draftTrace(finding({ verification: undefined }))).toBe("");
  });
});

describe("replyAppendix", () => {
  const check = (over: Partial<ThreadCheck> = {}): ThreadCheck => ({
    threadId: "t1", point: "x can be null here (reviewer's question)", raisedBy: "viewer", verdict: "holds",
    reason: "r", evidence: [{ path: "src/a.ts", line: 3, quote: "const x = f();" }], trace: [], reply: "Yes, it can.",
    head: "H1", lastCommentId: "c1", createdAt: "2026-01-01T00:00:00Z", ...over,
  });

  it("is empty for an unclear check", () => {
    expect(replyAppendix(check({ verdict: "unclear" }))).toBe("");
  });

  it("is a collapsed details block with the evidence listed and fenced", () => {
    const md = replyAppendix(check({ evidence: [
      { path: "src/a.ts", line: 3, quote: "const x = f();" },
      { path: "Makefile", line: null, quote: "a:\n\tb\n" },
    ] }));
    expect(md).toBe([
      "",
      "",
      "<details><summary>x can be null here (reviewer's question)</summary>",
      "",
      "- `src/a.ts:3`",
      "  `````ts",
      "  const x = f();",
      "  `````",
      "- `Makefile`",
      "  `````",
      "  a:",
      "  \tb",
      "  `````",
      "",
      "</details>",
    ].join("\n"));
  });

  it("adds the checked trace as a Path sub-list of numbered steps", () => {
    const md = replyAppendix(check({ verdict: "does_not_hold", trace: [step(), step({ path: "src/b.cpp", line: 10, quote: "int y;", note: "y" })] }));
    expect(md).toBe([
      "",
      "",
      "<details><summary>x can be null here (reviewer's question)</summary>",
      "",
      "- `src/a.ts:3`",
      "  `````ts",
      "  const x = f();",
      "  `````",
      "- Path",
      "  1. `src/a.ts:3` — x is read here",
      "     `````ts",
      "     const x = f();",
      "     `````",
      "  2. `src/b.cpp:10` — y",
      "     `````cpp",
      "     int y;",
      "     `````",
      "",
      "</details>",
    ].join("\n"));
  });

  it("leaves out the trace of a check riff could not fully read", () => {
    const md = replyAppendix(check({ trace: [step()], unchecked: true }));
    expect(md).toContain("- `src/a.ts:3`\n  `````ts\n  const x = f();\n  `````\n\n</details>");
    expect(md).not.toContain("Path");
  });

  it("names the summary when there is no point, and keeps it on one line", () => {
    expect(replyAppendix(check({ point: "  " }))).toContain("<summary>Checked in the code</summary>");
    expect(replyAppendix(check({ point: "a\n  b" }))).toContain("<summary>a b</summary>");
  });

  it("neutralises HTML, mentions and references in the point and the notes", () => {
    const md = replyAppendix(check({ point: "@team: a < b && #12", trace: [step({ note: "</details> @dev #3" })] }));
    expect(md).toContain(`<summary>@${WJ}team: a &lt; b &amp;&amp; #${WJ}12</summary>`);
    expect(md).toContain(`— &lt;/details&gt; @${WJ}dev #${WJ}3\n`);
    expect(md.match(/<\/details>/g)).toHaveLength(1);
  });

  it("fences a quote with a fence longer than its longest backtick run", () => {
    const md = replyAppendix(check({ evidence: [{ path: "a.ts", line: 1, quote: "let s = ``````x``````;" }] }));
    expect(md).toContain("  ```````ts\n  let s = ``````x``````;\n  ```````");
  });
});
