import { describe, expect, it, vi } from "vitest";

// workingCopy.ts imports the runes store (and, transitively via commitHistory,
// the Tauri `invoke` wrappers in git.ts) at module load. headRelativeStatus is
// a pure function of its StatusEntry argument, so an empty stub is enough —
// see workspace.test.ts for the same pattern.
vi.mock("./store.svelte", () => ({ appState: {} }));

import { headRelativeStatus, mergeDuplicatePaths } from "./workingCopy";
import type { StatusEntry } from "./types";

const entry = (index_status: string, worktree_status: string): StatusEntry => ({
  path: "a.ts",
  orig_path: null,
  index_status,
  worktree_status,
});

describe("headRelativeStatus", () => {
  it("reads an untracked file as added", () => {
    expect(headRelativeStatus(entry("?", "?"))).toBe("added");
  });

  it("keeps a staged add that was edited again as added", () => {
    expect(headRelativeStatus(entry("A", "M"))).toBe("added");
  });

  it("reads a staged edit that was deleted from disk as deleted", () => {
    expect(headRelativeStatus(entry("M", "D"))).toBe("deleted");
  });

  it("falls back to the worktree code when the index is clean", () => {
    expect(headRelativeStatus(entry(".", "M"))).toBe("modified");
    expect(headRelativeStatus(entry(".", "D"))).toBe("deleted");
    expect(headRelativeStatus(entry(".", "T"))).toBe("typechanged");
  });

  it("uses the index code when the worktree is clean", () => {
    expect(headRelativeStatus(entry("M", "."))).toBe("modified");
    expect(headRelativeStatus(entry("A", "."))).toBe("added");
    expect(headRelativeStatus(entry("D", "."))).toBe("deleted");
    expect(headRelativeStatus(entry("R", "."))).toBe("renamed");
    expect(headRelativeStatus(entry("C", "."))).toBe("copied");
  });

  it("keeps a rename that was edited again as renamed", () => {
    expect(headRelativeStatus(entry("R", "M"))).toBe("renamed");
  });

  it("reads a staged add whose disk copy was removed as added, not deleted", () => {
    // `git add g.txt && rm g.txt`: g.txt was never in HEAD, so there is no
    // HEAD blob to call "deleted" against even though Y says the disk copy
    // is gone too.
    expect(headRelativeStatus(entry("A", "D"))).toBe("added");
  });
});

describe("mergeDuplicatePaths", () => {
  it("collapses git rm --cached's two records for one path into one modified row", () => {
    // `git rm --cached f.txt` (disk copy left alone) makes porcelain v2 emit
    // two records for the same path:
    //   1 D. N... 100644 000000 000000 45b983b 0000000 f.txt
    //   ? f.txt
    const tracked = entry("D", ".");
    const untracked = entry("?", "?");
    const merged = mergeDuplicatePaths([tracked, untracked]);
    expect(merged.length).toBe(1);
    expect(merged[0].path).toBe(tracked.path);
    expect(headRelativeStatus(merged[0])).toBe("modified");
  });

  it("leaves entries with distinct paths untouched", () => {
    const a: StatusEntry = { ...entry("M", "."), path: "a.ts" };
    const b: StatusEntry = { ...entry("A", "."), path: "b.ts" };
    expect(mergeDuplicatePaths([a, b])).toEqual([a, b]);
  });

  it("passes a lone entry through unchanged", () => {
    const solo = entry("M", ".");
    expect(mergeDuplicatePaths([solo])).toEqual([solo]);
  });
});
