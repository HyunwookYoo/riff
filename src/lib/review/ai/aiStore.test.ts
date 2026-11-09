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

  it("invalid stored result loads as null", async () => {
    const bad: unknown[] = [
      null, "x", { version: 2 },
      { ...result(), key: "github.com/o/r#2" },
      { ...result(), headSha: 1 },
      { ...result(), chapters: [{ title: "T" }] },
      { ...result(), findings: [{ ...result().findings[0], side: "UP" }] },
      { ...result(), findings: [{ ...result().findings[0], quote: "x" }] },
      { ...result(), handled: { f0: "maybe" } },
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
