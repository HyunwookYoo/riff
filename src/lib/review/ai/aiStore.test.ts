import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  loadReview: vi.fn(async (_k: string) => null as unknown),
  saveReview: vi.fn(async (_k: string, _v: unknown) => {}),
}));
vi.mock("../gh", () => m);

import { aiKey, isAiKey, isStale, loadAiResult, saveAiResult } from "./aiStore";
import type { AiResult } from "./types";

const K = "github.com/o/r#1";
const result = (): AiResult => ({
  version: 1, key: K, headSha: "h1", baseSha: "b1", mergeBase: "m1", createdAt: "2026-11-09T00:00:00.000Z",
  chapters: [{ title: "T", summary: "s", paths: ["a.ts"] }],
  findings: [{
    id: "f0", path: "a.ts", side: "RIGHT", line: 2, startLine: null, severity: "high", body: "b",
    evidence: [{ path: "a.ts", line: 2, quote: "q" }], status: "confirmed", quote: ["x"],
  }],
  handled: { f0: "added" },
});

const rereview = () => ({
  fromHead: "r1", toHead: "h1", createdAt: "2026-11-09T00:00:00.000Z",
  verdicts: [{ threadId: "t", verdict: "addressed", reason: "ok", evidence: [{ path: "a.ts", line: null, quote: "q" }] }],
});

const threadCheck = () => ({
  threadId: "t", point: "p", raisedBy: "viewer", verdict: "holds", reason: "r",
  evidence: [{ path: "a.ts", line: 2, quote: "q" }], trace: [{ path: "a.ts", side: "RIGHT", line: 2, quote: "q", note: "n" }],
  reply: "Thanks.", head: "h1", lastCommentId: "c1", createdAt: "2026-11-16T00:00:00.000Z",
});
const threadCheckRun = () => ({ head: "h1", createdAt: "2026-11-16T00:00:00.000Z", checked: 1, leftOut: 0 });

beforeEach(() => vi.clearAllMocks());

describe("aiStore", () => {
  it("keys results apart from draft records", () => {
    expect(aiKey(K)).toBe(`${K}@ai`);
    expect(isAiKey(aiKey(K))).toBe(true);
    expect(isAiKey(K)).toBe(false);
  });

  it("saves under the @ai key and loads it back", async () => {
    await saveAiResult(result());
    expect(m.saveReview).toHaveBeenCalledWith(`${K}@ai`, result());
    m.loadReview.mockResolvedValueOnce(result());
    expect(await loadAiResult(K)).toEqual(result());
    expect(m.loadReview).toHaveBeenCalledWith(`${K}@ai`);
  });

  it("a stored result with or without a re-review loads", async () => {
    const withRr = { ...result(), rereview: rereview() };
    m.loadReview.mockResolvedValueOnce(withRr);
    expect(await loadAiResult(K)).toEqual(withRr);
    m.loadReview.mockResolvedValueOnce(result());
    expect(await loadAiResult(K)).toEqual(result());
  });

  it("thread checks are optional; a record may hold them, a re-review, or both", async () => {
    const checks = { t: threadCheck(), u: { ...threadCheck(), threadId: "u", verdict: "unclear", reply: "", problem: "no evidence" } };
    for (const v of [
      { ...result(), threadChecks: checks, threadCheckRun: threadCheckRun() },
      { ...result(), threadChecks: { t: { ...threadCheck(), unchecked: true } }, threadCheckRun: threadCheckRun() },
      { ...result(), threadChecks: { t: { ...threadCheck(), evidence: [{ path: "a.ts", line: 2, quote: "q", base: true }] } } },
      { ...result(), threadChecks: {}, threadCheckRun: threadCheckRun() },
      { ...result(), rereview: rereview() },
      { ...result(), rereview: rereview(), threadChecks: checks, threadCheckRun: threadCheckRun() },
    ]) {
      m.loadReview.mockResolvedValueOnce(v);
      expect(await loadAiResult(K), JSON.stringify(v)).toEqual(v);
    }
  });

  it("the model/effort a review ran with is optional: set, unset or absent (older records)", async () => {
    for (const v of [{ ...result(), model: "opus", effort: "high" }, { ...result(), model: null, effort: null }, result()]) {
      m.loadReview.mockResolvedValueOnce(v);
      expect(await loadAiResult(K)).toEqual(v);
    }
  });

  it("a finding's failure scenario is optional (older records have none)", async () => {
    const v = { ...result(), findings: [{ ...result().findings[0], failureScenario: "s" }] };
    m.loadReview.mockResolvedValueOnce(v);
    expect(await loadAiResult(K)).toEqual(v);
  });

  it("a finding's Roblox tag and the result's Roblox parity record are optional", async () => {
    const tagged = { ...result(), findings: [{ ...result().findings[0], tag: "roblox" }] };
    for (const v of [
      tagged,
      { ...result(), roblox: { docsSha: "d0c5", docsDate: "2026-11-10T08:00:00+09:00" } },
      { ...result(), roblox: { skipped: "Roblox docs not downloaded" } },
    ]) {
      m.loadReview.mockResolvedValueOnce(v);
      expect(await loadAiResult(K)).toEqual(v);
    }
  });

  it("a finding's verification and the refuted list are optional (older records have neither)", async () => {
    const step = { path: "b.ts", side: "LEFT", line: 3, quote: "q", note: "n" };
    for (const v of [
      { ...result(), findings: [{ ...result().findings[0], verification: { reason: "r", trace: [step] } }] },
      { ...result(), findings: [{ ...result().findings[0], verification: { reason: "r", trace: [], problem: "no failure path" } }] },
      { ...result(), findings: [{ ...result().findings[0], verification: { reason: "r", trace: [step, step], unchecked: true } }] },
      { ...result(), findings: [{ ...result().findings[0], verification: { reason: "r", trace: [{ ...step, movedFrom: 9 }, step] } }] },
      { ...result(), refuted: [] },
      { ...result(), refuted: [{ path: "a.ts", line: 4, severity: "low", summary: "s", reason: "r" }] },
      { ...result(), refuted: [{ path: "a.ts", side: "LEFT", line: 4, severity: "low", summary: "s", reason: "r" }] },
    ]) {
      m.loadReview.mockResolvedValueOnce(v);
      expect(await loadAiResult(K)).toEqual(v);
    }
  });

  it("invalid stored result loads as null", async () => {
    const step = { path: "b.ts", side: "LEFT", line: 3, quote: "q", note: "n" };
    const withVerification = (verification: unknown) => ({ ...result(), findings: [{ ...result().findings[0], verification }] });
    const refuted = { path: "a.ts", line: 4, severity: "low", summary: "s", reason: "r" };
    const badNew: unknown[] = [
      withVerification(null), withVerification({ trace: [] }), withVerification({ reason: "r" }),
      withVerification({ reason: "r", trace: [], problem: null }),
      withVerification({ reason: "r", trace: [], unchecked: "yes" }),
      withVerification({ reason: "r", trace: [{ ...step, side: "UP" }] }),
      withVerification({ reason: "r", trace: [{ ...step, line: "3" }] }),
      withVerification({ reason: "r", trace: [{ ...step, note: undefined }] }),
      withVerification({ reason: "r", trace: [{ ...step, movedFrom: "9" }] }),
      { ...result(), refuted: null }, { ...result(), refuted: {} },
      { ...result(), refuted: [{ ...refuted, severity: "huge" }] },
      { ...result(), refuted: [{ ...refuted, line: null }] },
      { ...result(), refuted: [{ ...refuted, reason: undefined }] },
      { ...result(), refuted: [{ ...refuted, side: "UP" }] },
      ...[
        { verdict: "maybe" }, { raisedBy: "nobody" }, { trace: {} }, { trace: [{ path: "a.ts" }] }, { reply: null }, { reply: undefined },
        { evidence: [{}] }, { evidence: [{ path: "a.ts", line: 2, quote: "q", base: false }] }, { point: 1 }, { head: undefined }, { lastCommentId: 1 }, { problem: null }, { unchecked: "yes" },
      ].map((bad) => ({ ...result(), threadChecks: { t: { ...threadCheck(), ...bad } } })),
      { ...result(), threadChecks: null }, { ...result(), threadChecks: [threadCheck()] },
      { ...result(), threadCheckRun: null }, { ...result(), threadCheckRun: { ...threadCheckRun(), checked: "1" } },
      { ...result(), threadCheckRun: { ...threadCheckRun(), leftOut: undefined } },
    ];
    for (const v of badNew) {
      m.loadReview.mockResolvedValueOnce(v);
      expect(await loadAiResult(K), JSON.stringify(v)).toBeNull();
    }
  });

  it("invalid stored result loads as null (older fields)", async () => {
    const bad: unknown[] = [
      null, "x", { version: 2 },
      { ...result(), key: "github.com/o/r#2" },
      { ...result(), headSha: 1 },
      { ...result(), chapters: [{ title: "T" }] },
      { ...result(), findings: [{ ...result().findings[0], side: "UP" }] },
      { ...result(), findings: [{ ...result().findings[0], quote: "x" }] },
      { ...result(), findings: [{ ...result().findings[0], failureScenario: 1 }] },
      { ...result(), findings: [{ ...result().findings[0], failureScenario: null }] },
      { ...result(), findings: [{ ...result().findings[0], tag: "unity" }] },
      { ...result(), findings: [{ ...result().findings[0], tag: null }] },
      { ...result(), roblox: null },
      { ...result(), roblox: {} },
      { ...result(), roblox: { docsSha: "d0c5" } },
      { ...result(), roblox: { docsSha: 1, docsDate: "x" } },
      { ...result(), roblox: { skipped: 1 } },
      { ...result(), handled: { f0: "maybe" } },
      { ...result(), model: 1 },
      { ...result(), effort: {} },
      { ...result(), rereview: null },
      { ...result(), rereview: { ...rereview(), toHead: 1 } },
      { ...result(), rereview: { ...rereview(), verdicts: [{ threadId: "t", verdict: "maybe", reason: "", evidence: [] }] } },
      { ...result(), rereview: { ...rereview(), verdicts: [{ threadId: "t", verdict: "addressed", reason: "", evidence: [{}] }] } },
    ];
    for (const v of bad) {
      m.loadReview.mockResolvedValueOnce(v);
      expect(await loadAiResult(K), JSON.stringify(v)).toBeNull();
    }
  });

  it("stale result is flagged", () => {
    expect(isStale(result(), "h1")).toBe(false);
    expect(isStale(result(), "h2")).toBe(true);
  });
});
