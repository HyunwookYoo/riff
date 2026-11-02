import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./store.svelte", () => ({ appState: {} }));
vi.mock("./git", () => ({ readFileAt: vi.fn() }));
vi.mock("./history", () => ({ snapshot: () => ({ tag: "snap" }) }));

import { blameBefore, blameRevFor, mapLineBack, type LineChange } from "./blameRev";
import { appState } from "./store.svelte";
import { readFileAt } from "./git";
import type { BlameCommit, BlameRev } from "./types";

// Changes are character offsets, old = a, new = b, as @codemirror/merge's
// `diff` returns them.
const ch = (fromA: number, toA: number, fromB: number, toB: number): LineChange => ({
  fromA,
  toA,
  fromB,
  toB,
});

describe("mapLineBack", () => {
  it("keeps a line when nothing changed", () => {
    expect(mapLineBack("a\nb\nc\n", "a\nb\nc\n", [], 2)).toBe(2);
  });

  it("keeps a line above a change and maps a modified line to itself", () => {
    // "b" -> "B" on line 2.
    const c = [ch(2, 3, 2, 3)];
    expect(mapLineBack("a\nb\nc\n", "a\nB\nc\n", c, 1)).toBe(1);
    expect(mapLineBack("a\nb\nc\n", "a\nB\nc\n", c, 2)).toBe(2);
  });

  it("maps inserted lines to the insertion point and shifts lines below", () => {
    // "b1\nb2\n" inserted at the start of old line 2.
    const c = [ch(2, 2, 2, 8)];
    const oldT = "a\nc\n";
    const newT = "a\nb1\nb2\nc\n";
    expect(mapLineBack(oldT, newT, c, 2)).toBe(2);
    expect(mapLineBack(oldT, newT, c, 3)).toBe(2);
    expect(mapLineBack(oldT, newT, c, 4)).toBe(2);
  });

  it("shifts a line below deleted lines", () => {
    // "x\ny\n" deleted from old lines 2-3.
    const c = [ch(2, 6, 2, 2)];
    expect(mapLineBack("a\nx\ny\nc\n", "a\nc\n", c, 2)).toBe(4);
  });

  it("clamps a line past either file's end", () => {
    expect(mapLineBack("a\n", "a\nb\nc\n", [ch(2, 2, 2, 6)], 99)).toBe(2);
  });
});

const target = { repoIdx: 0, path: "new.md" };
const rev: BlameRev = {
  target,
  rev: "p".repeat(40),
  path: "old.md",
  before: { sha: "c1c1c1c1", summary: "s" },
  line: 1,
};

describe("blameRevFor", () => {
  it("is the revision only while its file is the one blamed", () => {
    expect(blameRevFor(rev, target)).toBe(rev);
    expect(blameRevFor(rev, { repoIdx: 0, path: "other.md" })).toBeNull();
    expect(blameRevFor(rev, { repoIdx: 1, path: "new.md" })).toBeNull();
    expect(blameRevFor(null, target)).toBeNull();
  });
});

describe("blameBefore", () => {
  const commit: BlameCommit = {
    sha: "c1c1c1c1",
    author: "a",
    author_time: 0,
    summary: "rename and edit",
    filename: "new.md",
    previous: { sha: "p".repeat(40), path: "old.md" },
  };

  beforeEach(() => {
    Object.assign(appState, {
      repos: [{ path: "/main", kind: "main", displayName: "main" }],
      appMode: "blame",
      blameTarget: target,
      blameRev: null,
      history: [],
      forwardHistory: [{ tag: "stale" }],
    });
    vi.mocked(readFileAt).mockReset();
  });

  it("pushes the view and blames the parent at the mapped line", async () => {
    vi.mocked(readFileAt).mockImplementation(async (_repo, r) =>
      r === commit.sha ? "a\nb\nc\n" : "a\nc\n",
    );
    await blameBefore(commit, 3);
    expect(readFileAt).toHaveBeenCalledWith("/main", "p".repeat(40), "old.md");
    expect(readFileAt).toHaveBeenCalledWith("/main", "c1c1c1c1", "new.md");
    expect(appState.history).toEqual([{ tag: "snap" }]);
    expect(appState.forwardHistory).toEqual([]);
    expect(appState.blameRev).toEqual({
      target,
      rev: "p".repeat(40),
      path: "old.md",
      before: { sha: "c1c1c1c1", summary: "rename and edit" },
      line: 2,
    });
  });

  it("falls back to the commit's own line when a version can't be read", async () => {
    vi.mocked(readFileAt).mockRejectedValue("gone");
    await blameBefore(commit, 5);
    expect(appState.blameRev?.line).toBe(5);
  });

  it("maps a line in a large, heavily rewritten file quickly", async () => {
    // 20,000 lines with every 3rd one changed: an unbounded character diff
    // takes over a minute on this.
    const n = 20_000;
    const oldLines = Array.from({ length: n }, (_, i) => `line ${i} of the old text`);
    const newLines = oldLines.map((l, i) => (i % 3 === 0 ? `changed ${i} in the new text` : l));
    vi.mocked(readFileAt).mockImplementation(async (_repo, r) =>
      (r === commit.sha ? newLines : oldLines).join("\n") + "\n",
    );
    const started = performance.now();
    await blameBefore(commit, 10_000);
    expect(performance.now() - started).toBeLessThan(3000);
    const line = appState.blameRev!.line;
    expect(Number.isInteger(line)).toBe(true);
    expect(line).toBeGreaterThanOrEqual(1);
    expect(line).toBeLessThanOrEqual(n);
  });

  it("pushes one frame when activated twice during the reads", async () => {
    vi.mocked(readFileAt).mockResolvedValue("a\n");
    await Promise.all([blameBefore(commit, 1), blameBefore(commit, 1)]);
    expect(appState.history).toEqual([{ tag: "snap" }]);
  });

  it("pushes nothing when Blame is left during the reads", async () => {
    vi.mocked(readFileAt).mockResolvedValue("a\n");
    const step = blameBefore(commit, 1);
    appState.appMode = "compare";
    await step;
    expect(appState.history).toEqual([]);
    expect(appState.blameRev).toBeNull();
  });

  it("pushes nothing when another file is blamed during the reads", async () => {
    vi.mocked(readFileAt).mockResolvedValue("a\n");
    const step = blameBefore(commit, 1);
    appState.blameTarget = { repoIdx: 0, path: "other.md" };
    await step;
    expect(appState.history).toEqual([]);
    expect(appState.blameRev).toBeNull();
  });

  it("does nothing for a commit that added the file", async () => {
    await blameBefore({ ...commit, previous: null }, 3);
    expect(appState.history).toEqual([]);
    expect(appState.blameRev).toBeNull();
  });
});
