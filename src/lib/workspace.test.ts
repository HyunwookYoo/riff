import { describe, it, expect, beforeEach, vi } from "vitest";

// workspace.ts imports the runes store, Tauri `invoke` wrappers, and the
// compare()/blame caches at module load. None matter to the pure ref-resolution
// logic under test, so stub them out. Mock specifiers are resolved relative to
// THIS file, which shares src/lib with workspace.ts.
vi.mock("./store.svelte", () => ({
  appState: { repos: [], startBranch: "", targetBranch: "" },
}));
vi.mock("./git", () => ({}));
vi.mock("./compare", () => ({}));
vi.mock("./blameCache", () => ({}));

import { repoPathFor } from "./workspace";
import { appState } from "./store.svelte";

beforeEach(() => {
  appState.repos = [];
  appState.startBranch = "";
  appState.targetBranch = "";
});

describe("repoPathFor", () => {
  it("returns null for a null target", () => {
    expect(repoPathFor(null)).toBeNull();
  });

  it("maps a RepoFile's repoIdx to its repo path", () => {
    appState.repos = [
      { path: "/main", kind: "main", displayName: "main" },
      { path: "/sub", kind: "submodule", displayName: "sub" },
    ];
    expect(repoPathFor({ repoIdx: 1, path: "x.rs" })).toBe("/sub");
  });

  it("returns null when the repoIdx no longer exists", () => {
    appState.repos = [];
    expect(repoPathFor({ repoIdx: 3, path: "x.rs" })).toBeNull();
  });
});
