import { describe, it, expect } from "vitest";
import { emptyRecord, addItem, editItem, reanchorAll, submittable, parseRecord } from "./draft";
import type { FileHunks } from "./types";

const K = "h/o/r#1";
const line = (path: string, l: number, quote: string[]) =>
  ({ kind: "line", path, side: "RIGHT", line: l, startLine: null, quote }) as const;

describe("draft", () => {
  it("editing an ai item marks it ai-edited", () => {
    let r = addItem(emptyRecord(K), line("a.ts", 1, ["x"]), "b", "ai");
    r = editItem(r, r.items[0].id, "c");
    expect(r.items[0].origin).toBe("ai-edited");
    expect(r.items[0].body).toBe("c");
  });

  it("reanchorAll flags unplaced items and keeps them", () => {
    let r = addItem(emptyRecord(K), line("a.ts", 2, ["gone"]), "b", "mine");
    const fh: FileHunks[] = [{ path: "a.ts", oldPath: null, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 }] }];
    r = reanchorAll(r, "new", new Map([["a.ts|RIGHT", "p\nq\nr\n"]]), fh);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].unplaced).toBe(true);
    expect((r.items[0].target as any).line).toBe(2);
    expect(r.anchorHead).toBe("new");
  });

  it("reanchorAll leaves reply items untouched", () => {
    let r = addItem(emptyRecord(K), { kind: "reply", threadId: "t", preview: "p" }, "b", "mine");
    const before = r.items[0];
    r = reanchorAll(r, "new", new Map(), []);
    expect(r.items[0]).toEqual(before);
  });

  it("submittable excludes unplaced", () => {
    let r = addItem(emptyRecord(K), line("a.ts", 1, ["x"]), "b", "mine");
    r = addItem(r, { kind: "body", location: "" }, "c", "mine");
    r = { ...r, items: [{ ...r.items[0], unplaced: true }, r.items[1]] };
    expect(submittable(r)).toHaveLength(1);
  });

  it("parseRecord rejects unknown versions", () => {
    expect(parseRecord(null, K)).toEqual(emptyRecord(K));
    expect(parseRecord({ version: 2, key: K, items: [1] }, K)).toEqual(emptyRecord(K));
    const ok = { ...emptyRecord(K), body: "hi" };
    expect(parseRecord(ok, K).body).toBe("hi");
  });
});
