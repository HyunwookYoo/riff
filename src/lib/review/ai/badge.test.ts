import { describe, expect, it } from "vitest";
import { aiBadge, aiErrorText } from "./badge";
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
  it("stale when head moved", () => {
    expect(aiBadge(undefined, result("old"), "new", 0)).toEqual({ text: "PR updated · re-analyse", kind: "stale" });
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
