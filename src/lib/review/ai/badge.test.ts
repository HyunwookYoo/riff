import { describe, expect, it } from "vitest";
import { aiBadge, aiBadgeTitle, aiErrorText, rereviewButtonState, shouldLoad } from "./badge";
import type { AiFinding, AiResult } from "./types";

const finding = (id: string, status: AiFinding["status"]): AiFinding => ({
  id, path: "a.ts", side: "RIGHT", line: 1, startLine: null, severity: "low",
  body: "b", evidence: [], status, quote: [],
});
const result = (headSha: string, findings: AiFinding[] = [], handled: AiResult["handled"] = {}): AiResult => ({
  version: 1, key: "k", headSha, baseSha: "b", mergeBase: "m",
  createdAt: "", chapters: [], findings, handled,
});

describe("aiBadge", () => {
  it("none without job or result", () => {
    expect(aiBadge(undefined, undefined, "h", 0)).toEqual({ text: "", kind: "none" });
    expect(aiBadge(undefined, null, "h", 0)).toEqual({ text: "", kind: "none" });
  });
  it("queued", () => {
    expect(aiBadge({ kind: "queued" }, null, "h", 0)).toEqual({ text: "queued", kind: "queued" });
  });
  it("running shows m:ss", () => {
    const job = { kind: "running", pass: "find", startedAt: 1000, lastActivity: null } as const;
    expect(aiBadge(job, null, "h", 1000 + 101_000)).toEqual({ text: "analysing 1:41", kind: "running" });
    expect(aiBadge(job, null, "h", 1000 + 5_000).text).toBe("analysing 0:05");
    expect(aiBadge(job, null, "h", 0).text).toBe("analysing 0:00");
  });
  it("failed", () => {
    expect(aiBadge({ kind: "failed", message: "x" }, null, "h", 0)).toEqual({ text: "AI failed", kind: "failed" });
  });
  it("ready counts confirmed, unhandled findings", () => {
    const r = result("h", [finding("f0", "confirmed"), finding("f1", "confirmed"), finding("f2", "unconfirmed")], { f1: "added" });
    expect(aiBadge({ kind: "done" }, r, "h", 0)).toEqual({ text: "AI ready · ⚠1", kind: "ready" });
    expect(aiBadge(undefined, r, "h", 0).kind).toBe("ready");
  });
  it("queued and running win over a cached result", () => {
    const r = result("h", [finding("f0", "confirmed")]);
    expect(aiBadge({ kind: "queued" }, r, "h", 0).kind).toBe("queued");
    const job = { kind: "running", pass: "verify", startedAt: 0, lastActivity: null } as const;
    expect(aiBadge(job, r, "h", 0).kind).toBe("running");
  });
  it("done without a result is none", () => {
    expect(aiBadge({ kind: "done" }, null, "h", 0)).toEqual({ text: "", kind: "none" });
    expect(aiBadge({ kind: "done" }, undefined, "h", 0)).toEqual({ text: "", kind: "none" });
  });
  it("ready with no open findings shows 0", () => {
    expect(aiBadge({ kind: "done" }, result("h"), "h", 0)).toEqual({ text: "AI ready · ⚠0", kind: "ready" });
  });
  it("a failed re-run keeps showing a result for the current head", () => {
    const failed = { kind: "failed", message: "x" } as const;
    expect(aiBadge(failed, result("h", [finding("f0", "confirmed")]), "h", 0)).toEqual({ text: "AI ready · ⚠1", kind: "ready" });
    expect(aiBadge(failed, result("old"), "h", 0).kind).toBe("failed");
  });
  it("stale when head moved", () => {
    expect(aiBadge(undefined, result("old"), "new", 0)).toEqual({ text: "PR updated · re-analyse", kind: "stale" });
  });
  it("a result holding only a re-review is no AI review", () => {
    const rereview = { fromHead: "o", toHead: "h", createdAt: "", verdicts: [] };
    expect(aiBadge(undefined, { ...result(""), rereview }, "h", 0)).toEqual({ text: "", kind: "none" });
    expect(aiBadge({ kind: "failed", message: "x" }, { ...result(""), rereview }, "h", 0).kind).toBe("failed");
  });
});

describe("aiBadgeTitle", () => {
  it("names the model and effort the review ran with", () => {
    expect(aiBadgeTitle(undefined, { ...result("h"), model: "opus", effort: "high" })).toBe("AI review ran with opus · high");
    expect(aiBadgeTitle({ kind: "done" }, result("h"))).toBe("AI review ran with default");
  });
  it("a failure wins; nothing without a review", () => {
    expect(aiBadgeTitle({ kind: "failed", message: " boom " }, { ...result("h"), model: "opus" })).toBe("boom");
    expect(aiBadgeTitle(undefined, null)).toBeUndefined();
    const rereview = { fromHead: "o", toHead: "h", createdAt: "", verdicts: [] };
    expect(aiBadgeTitle(undefined, { ...result(""), rereview })).toBeUndefined();
  });
});

describe("aiErrorText", () => {
  it("maps malformed answers", () => {
    expect(aiErrorText("ai-malformed: verdicts missing")).toBe("The AI returned an unexpected answer — try again.");
  });
  it("passes others through trimmed to 200 chars", () => {
    expect(aiErrorText("  Claude Code CLI is not installed \n")).toBe("Claude Code CLI is not installed");
    expect(aiErrorText("x".repeat(300))).toHaveLength(200);
  });
});

describe("shouldLoad", () => {
  it("loads only unknown, not-in-flight keys", () => {
    expect(shouldLoad("a", {}, new Set())).toBe(true);
    expect(shouldLoad("a", { a: null }, new Set())).toBe(false);
    expect(shouldLoad("a", {}, new Set(["a"]))).toBe(false);
  });
});

describe("rereviewButtonState", () => {
  it("idle after no job or a finished one", () => {
    expect(rereviewButtonState(undefined, 0)).toEqual({ text: "Re-review", busy: false });
    expect(rereviewButtonState({ kind: "done" }, 0)).toEqual({ text: "Re-review", busy: false });
  });
  it("queued", () => {
    expect(rereviewButtonState({ kind: "queued" }, 0)).toEqual({ text: "re-review queued", busy: true });
  });
  it("running shows m:ss", () => {
    const job = { kind: "running", pass: "rereview", startedAt: 1000, lastActivity: null } as const;
    expect(rereviewButtonState(job, 1000 + 65_000)).toEqual({ text: "re-reviewing 1:05", busy: true });
  });
  it("failed carries the error as tooltip and can be retried", () => {
    expect(rereviewButtonState({ kind: "failed", message: "ai-malformed: x" }, 0)).toEqual({
      text: "re-review failed", busy: false, title: "The AI returned an unexpected answer — try again.",
    });
  });
});
