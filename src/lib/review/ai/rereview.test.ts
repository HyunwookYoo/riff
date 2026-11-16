import { describe, expect, it } from "vitest";
import { hasReview, verdictLabel } from "./rereview";
import { NO_ANSWER, type AiResult, type ThreadVerdict } from "./types";

describe("verdictLabel", () => {
  const v = (verdict: ThreadVerdict["verdict"]): ThreadVerdict => ({ threadId: "t", verdict, reason: "", evidence: [] });
  it("labels each verdict", () => {
    expect(verdictLabel(v("addressed"), false)).toEqual({ text: "✓ Addressed", tone: "ok" });
    expect(verdictLabel(v("not_addressed"), false)).toEqual({ text: "✗ Not addressed", tone: "warn" });
    expect(verdictLabel(v("unclear"), false)).toEqual({ text: "? Unclear", tone: "muted" });
  });
  it("marks a verdict from another head", () => {
    expect(verdictLabel(v("addressed"), true)).toEqual({ text: "✓ Addressed (other commit)", tone: "ok" });
  });
  it("marks a placeholder verdict with no answer", () => {
    const na: ThreadVerdict = { threadId: "t", verdict: "unclear", reason: NO_ANSWER, evidence: [] };
    expect(verdictLabel(na, false)).toEqual({ text: "? Unclear (no answer)", tone: "muted" });
    expect(verdictLabel(na, true)).toEqual({ text: "? Unclear (no answer) (other commit)", tone: "muted" });
  });
  it("is null without a verdict", () => {
    expect(verdictLabel(undefined, false)).toBeNull();
  });
});

describe("hasReview", () => {
  it("is true for a reviewed record, false for one holding only thread state", () => {
    const r = { version: 1, key: "k", headSha: "H", baseSha: "B", mergeBase: "M", createdAt: "c", chapters: [], findings: [], handled: {} } satisfies AiResult;
    expect(hasReview(r)).toBe(true);
    expect(hasReview({ ...r, headSha: "" })).toBe(false);
  });
});
