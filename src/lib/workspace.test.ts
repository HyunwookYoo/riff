import { describe, it, expect, beforeEach, vi } from "vitest";

// workspace.ts imports the runes store, Tauri `invoke` wrappers, and the
// compare()/blame caches at module load. None matter to the pure ref-resolution
// logic under test, so stub them out. Mock specifiers are resolved relative to
// THIS file, which shares src/lib with workspace.ts.
vi.mock("./store.svelte", () => ({
  appState: { repos: [], startBranch: "", targetBranch: "" },
}));
vi.mock("./git", () => ({ submoduleShaAt: vi.fn() }));
vi.mock("./compare", () => ({}));
vi.mock("./blameCache", () => ({}));

import { resolveDiffRefsFor, repoPathFor } from "./workspace";
import { appState } from "./store.svelte";
import { submoduleShaAt } from "./git";

beforeEach(() => {
  appState.repos = [];
  appState.startBranch = "";
  appState.targetBranch = "";
  vi.mocked(submoduleShaAt).mockReset();
});

describe("resolveDiffRefsFor", () => {
  it("returns null for an out-of-range repo index", async () => {
    expect(await resolveDiffRefsFor(0)).toBeNull();
  });

  it("uses main's start/target branches for the main repo", async () => {
    appState.repos = [{ path: "/repo", kind: "main", displayName: "repo" }];
    appState.startBranch = "main";
    appState.targetBranch = "feature";
    expect(await resolveDiffRefsFor(0)).toEqual({
      path: "/repo",
      start: "main",
      target: "feature",
    });
  });

  it("returns null when main is missing one of its branches", async () => {
    appState.repos = [{ path: "/repo", kind: "main", displayName: "repo" }];
    appState.startBranch = "main";
    appState.targetBranch = "";
    expect(await resolveDiffRefsFor(0)).toBeNull();
  });

  it("prefers a per-repo override over main's branches", async () => {
    appState.repos = [
      { path: "/main", kind: "main", displayName: "main" },
      {
        path: "/manual",
        kind: "manual",
        displayName: "manual",
        override: { startBranch: "v1", targetBranch: "v2" },
      },
    ];
    appState.startBranch = "ignored";
    appState.targetBranch = "ignored-too";
    expect(await resolveDiffRefsFor(1)).toEqual({
      path: "/manual",
      start: "v1",
      target: "v2",
    });
  });

  it("resolves a submodule to its gitlink SHAs at main's refs", async () => {
    appState.repos = [
      { path: "/main", kind: "main", displayName: "main" },
      {
        path: "/main/sub",
        kind: "submodule",
        displayName: "sub",
        parentGitlinkPath: "sub",
      },
    ];
    appState.startBranch = "main";
    appState.targetBranch = "feature";
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce("oldsha")
      .mockResolvedValueOnce("newsha");

    expect(await resolveDiffRefsFor(1)).toEqual({
      path: "/main/sub",
      start: "oldsha",
      target: "newsha",
    });
    expect(submoduleShaAt).toHaveBeenCalledWith("/main", "main", "sub");
    expect(submoduleShaAt).toHaveBeenCalledWith("/main", "feature", "sub");
  });

  it("returns null when a submodule gitlink SHA can't be resolved", async () => {
    appState.repos = [
      { path: "/main", kind: "main", displayName: "main" },
      {
        path: "/main/sub",
        kind: "submodule",
        displayName: "sub",
        parentGitlinkPath: "sub",
      },
    ];
    appState.startBranch = "main";
    appState.targetBranch = "feature";
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("newsha");

    expect(await resolveDiffRefsFor(1)).toBeNull();
  });

  it("falls back to main's branches for a manual repo without override", async () => {
    appState.repos = [
      { path: "/main", kind: "main", displayName: "main" },
      { path: "/manual", kind: "manual", displayName: "manual" },
    ];
    appState.startBranch = "a";
    appState.targetBranch = "b";
    expect(await resolveDiffRefsFor(1)).toEqual({
      path: "/manual",
      start: "a",
      target: "b",
    });
  });
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
