import { describe, expect, it } from "vitest";
import { findPrompt, verifyPrompt } from "./prompts";
import type { PrDetail, PrSummary } from "../types";

const pr = { number: 7, title: "Fix the thing" } as PrSummary;
const detail = { body: "Body text here" } as PrDetail;
const base = { repoPath: "C:/r", pr, detail, commits: ["first commit", "second commit"], mergeBase: "aaa111", head: "bbb222", diff: "diff --git a/x b/x" };

describe("findPrompt", () => {
  it("includes shas, diff and the read-only rules", () => {
    const p = findPrompt(base);
    for (const s of ["Fix the thing", "Body text here", "first commit", "second commit", "aaa111", "bbb222", "diff --git a/x b/x",
      "git show <head>:<path>", "git grep -n", "git log", "git ls-tree", "git cat-file", "never modify", "LEFT", "RIGHT",
      "language of the PR description", "normal prose"]) {
      expect(p).toContain(s);
    }
  });
  it("truncates a huge diff with a marker", () => {
    const p = findPrompt({ ...base, diff: "x".repeat(250_000) });
    expect(p).toContain("[diff truncated]");
    expect(p.length).toBeLessThan(230_000);
  });
});

describe("verifyPrompt", () => {
  it("asks to refute and lists candidates", () => {
    const p = verifyPrompt({ repoPath: "r", head: "bbb222", mergeBase: "aaa111",
      candidates: [{ index: 0, path: "a.ts", side: "RIGHT", line: 3, startLine: null, severity: "low", body: "cand body", evidence: [] }] });
    for (const s of ["refute", "confirmed", "refuted", "unconfirmed", "cand body", "a.ts", "bbb222"]) expect(p).toContain(s);
  });
});
