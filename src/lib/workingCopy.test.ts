import { describe, expect, it, vi } from "vitest";

// workingCopy.ts imports the runes store (and, transitively via commitHistory,
// the Tauri `invoke` wrappers in git.ts) at module load. headRelativeStatus is
// a pure function of its StatusEntry argument, so an empty stub is enough —
// see workspace.test.ts for the same pattern.
vi.mock("./store.svelte", () => ({ appState: {} }));

import { headRelativeStatus } from "./workingCopy";
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
});
