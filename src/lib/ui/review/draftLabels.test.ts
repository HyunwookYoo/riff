import { describe, it, expect } from "vitest";
import type { DraftItem } from "$lib/review/types";
import { itemLocation, originTag, itemPreview } from "./draftLabels";

const it_ = (target: DraftItem["target"], origin: DraftItem["origin"] = "mine"): DraftItem =>
  ({ id: "x", target, body: "b", origin, unplaced: false });
const line = (startLine: number | null, quote = ["  const a = 1;", "b"]) =>
  it_({ kind: "line", path: "src/a.ts", side: "RIGHT", line: 9, startLine, quote });

describe("draft labels", () => {
  it("locations per kind", () => {
    expect(itemLocation(line(null))).toBe("src/a.ts:9");
    expect(itemLocation(line(4))).toBe("src/a.ts:4-9");
    expect(itemLocation(it_({ kind: "file", path: "x.ts", location: "L" }))).toBe("x.ts (file)");
    expect(itemLocation(it_({ kind: "body", location: "L" }))).toBe("review body");
    expect(itemLocation(it_({ kind: "reply", threadId: "t", preview: "p" }))).toBe("reply to thread");
  });

  it("origin tags", () => {
    expect(originTag(line(null))).toBe("mine");
    expect(originTag(it_({ kind: "reply", threadId: "t", preview: "p" }))).toBe("reply");
    expect(originTag(it_({ kind: "body", location: "L" }, "ai"))).toBe("AI draft");
    expect(originTag(it_({ kind: "body", location: "L" }, "ai-edited"))).toBe("AI draft, edited");
    expect(originTag(it_({ kind: "body", location: "L" }, "ai-unconfirmed"))).toBe("Unconfirmed");
  });

  it("preview is the first quoted line or the reply preview", () => {
    expect(itemPreview(line(null))).toBe("  const a = 1;");
    expect(itemPreview(line(null, []))).toBeNull();
    expect(itemPreview(it_({ kind: "reply", threadId: "t", preview: "looks off" }))).toBe("looks off");
    expect(itemPreview(it_({ kind: "file", path: "x.ts", location: "L" }))).toBeNull();
  });
});
