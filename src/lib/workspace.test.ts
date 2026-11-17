import { describe, it, expect, beforeEach, vi } from "vitest";

// workspace.ts imports the runes store, Tauri `invoke` wrappers, and the
// compare()/blame caches at module load. None matter to the pure ref-resolution
// logic under test, so stub them out. Mock specifiers are resolved relative to
// THIS file, which shares src/lib with workspace.ts.
vi.mock("./store.svelte", () => ({
  appState: { repos: [], startBranch: "", targetBranch: "" },
}));
vi.mock("./git", () => ({
  validateRepo: vi.fn().mockRejectedValue("not a repo"),
  listSubmodules: vi.fn().mockResolvedValue([]),
  listRefs: vi.fn().mockResolvedValue([]),
  addRecentRepo: vi.fn().mockResolvedValue([]),
  listRepoFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock("./compare", () => ({}));
vi.mock("./blameCache", () => ({ clearBlameCache: vi.fn() }));
vi.mock("./commitHistory", () => ({ resetHistory: vi.fn(), enterHistoryMode: vi.fn() }));
vi.mock("./workingCopy", () => ({
  loadCurrentBranch: vi.fn(),
  loadPendingOp: vi.fn(),
  loadStatus: vi.fn(),
  resetWorkingCopy: vi.fn(),
}));

import { loadMainRepo, repoPathFor } from "./workspace";
import { appState } from "./store.svelte";
import { validateRepo } from "./git";
import { enterHistoryMode } from "./commitHistory";
import { loadStatus } from "./workingCopy";

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

describe("loadMainRepo", () => {
  it("drops the previous repo's Back and Forward stacks", async () => {
    // The frames restore the old repo's blame and commit view.
    appState.history = [{ appMode: "blame" } as never];
    appState.forwardHistory = [{ appMode: "compare" } as never];
    // The open itself fails (validateRepo rejects); the reset before it is
    // what this checks.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadMainRepo("/other", { silent: true });
    expect(appState.history).toEqual([]);
    expect(appState.forwardHistory).toEqual([]);
  });

  it("reloads the graph for the new repo when switching repos in graph view", async () => {
    // resetHistory drops the old repo's log; without a refetch the graph stays empty.
    vi.mocked(validateRepo).mockResolvedValueOnce("/other");
    appState.manualReposByMain = {};
    appState.tabOrderByMain = {};
    appState.appMode = "history";
    await loadMainRepo("/other");
    expect(appState.error).toBeNull();
    expect(enterHistoryMode).toHaveBeenCalledTimes(1);
    expect(loadStatus).not.toHaveBeenCalled();
  });
});
