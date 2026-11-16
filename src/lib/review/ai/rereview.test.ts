import { describe, expect, it } from "vitest";
import { hasReview, rereviewAvailable, verdictLabel } from "./rereview";
import { NO_ANSWER, type AiResult, type ThreadVerdict } from "./types";
import type { PrSummary, ReviewThread } from "../types";

const thread = (id: string, o: Partial<ReviewThread> = {}, authors = ["me"]): ReviewThread => ({
  id, path: "a.ts", side: "RIGHT", line: 3, startLine: null, originalLine: 3, isResolved: false, isOutdated: false,
  subjectType: "LINE",
  comments: authors.map((author, i) => ({ id: `${id}c${i}`, author, body: `${id} body ${i}`, createdAt: "" })),
  ...o,
});

const summary = (o: Partial<PrSummary> = {}): PrSummary => ({
  key: "github.com/o/r#1", repo: { host: "github.com", owner: "o", name: "r" }, repoIdx: 0,
  remote: "origin", nodeId: "N1", number: 1, title: "PR 1", author: "dev", url: "u",
  additions: 1, deletions: 1, headSha: "H1", baseSha: "B0", baseRef: "main", updatedAt: "",
  mine: "reviewed", myLastReviewSha: "R1", viewer: "me", ...o,
});

describe("rereviewAvailable", () => {
  it("rereviewAvailable needs a moved head and my open threads", () => {
    const mine = [thread("t1")];
    expect(rereviewAvailable(summary(), mine, "me")).toBe(true);
    expect(rereviewAvailable(summary({ myLastReviewSha: null }), mine, "me")).toBe(false);
    expect(rereviewAvailable(summary({ myLastReviewSha: "H1" }), mine, "me")).toBe(false);
    expect(rereviewAvailable(summary(), [thread("t1", { isResolved: true })], "me")).toBe(false);
    expect(rereviewAvailable(summary(), mine, "other")).toBe(false);
  });
});

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
  it("is false for a record holding only thread state", () => {
    const r = { version: 1, key: "k", headSha: "H", baseSha: "B", mergeBase: "M", createdAt: "c", chapters: [], findings: [], handled: {} } satisfies AiResult;
    expect(hasReview(r)).toBe(true);
    expect(hasReview({ ...r, headSha: "" })).toBe(false);
  });
});
