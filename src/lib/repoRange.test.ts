import { describe, it, expect, beforeEach, vi } from "vitest";

// repoRange.ts reads the runes store and calls two Tauri bindings; all are
// stubbed. Specifiers resolve relative to this file (src/lib).
vi.mock("./store.svelte", () => ({
  appState: {
    repos: [],
    repoPath: "",
    startBranch: "",
    targetBranch: "",
    refsRefresh: 0,
    repoRanges: [],
  },
}));
vi.mock("./git", () => ({ submoduleShaAt: vi.fn(), hasCommit: vi.fn() }));

import {
  resetRepoRanges,
  resolveRepoRange,
  resolveRepoRanges,
} from "./repoRange";
import { appState } from "./store.svelte";
import { hasCommit, submoduleShaAt } from "./git";
import type { RepoEntry } from "./types";

const main: RepoEntry = { path: "/main", kind: "main", displayName: "main" };
const sub: RepoEntry = {
  path: "/main/sub",
  kind: "submodule",
  displayName: "sub",
  parentGitlinkPath: "sub",
};
const manual: RepoEntry = {
  path: "/manual",
  kind: "manual",
  displayName: "manual",
};

beforeEach(() => {
  vi.mocked(submoduleShaAt).mockReset();
  // Every ref exists in its clone unless a test says otherwise.
  vi.mocked(hasCommit).mockReset();
  vi.mocked(hasCommit).mockResolvedValue(true);
  resetRepoRanges();
  appState.repos = [];
  appState.repoPath = "";
  appState.startBranch = "";
  appState.targetBranch = "";
  appState.refsRefresh = 0;
  appState.repoRanges = [];
});

describe("resolveRepoRange", () => {
  it("uses the toolbar pair for main", async () => {
    expect(await resolveRepoRange(main, "/main", "main", "feature")).toEqual({
      ok: true,
      path: "/main",
      base: "main",
      compare: "feature",
      source: "toolbar",
    });
  });

  it("reports no-refs for main while a side is empty", async () => {
    expect(await resolveRepoRange(main, "/main", "main", "")).toEqual({
      ok: false,
      reason: "no-refs",
    });
  });

  it("prefers an override over the gitlinks", async () => {
    const r: RepoEntry = {
      ...sub,
      override: { startBranch: "develop", targetBranch: "feature/y" },
    };
    expect(await resolveRepoRange(r, "/main", "main", "feature")).toEqual({
      ok: true,
      path: "/main/sub",
      base: "develop",
      compare: "feature/y",
      source: "override",
    });
    expect(submoduleShaAt).not.toHaveBeenCalled();
  });

  it("reports no-refs for an override with a side cleared", async () => {
    const r: RepoEntry = {
      ...sub,
      override: { startBranch: "develop", targetBranch: "" },
    };
    expect(await resolveRepoRange(r, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "no-refs",
    });
  });

  it("follows the commits the super repo's refs pin", async () => {
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce("aaa")
      .mockResolvedValueOnce("bbb");
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: true,
      path: "/main/sub",
      base: "aaa",
      compare: "bbb",
      source: "gitlink",
    });
    expect(submoduleShaAt).toHaveBeenCalledWith("/main", "main", "sub");
    expect(submoduleShaAt).toHaveBeenCalledWith("/main", "feature", "sub");
  });

  it("reports unchanged, with the pin, when both refs pin one commit", async () => {
    // Regression: resolveDiffRefsFor returned a range here while compare()
    // skipped the repo.
    vi.mocked(submoduleShaAt).mockResolvedValue("aaa");
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "unchanged",
      pin: "aaa",
    });
  });

  it("reports added when only compare pins the submodule", async () => {
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("bbb");
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "added",
      pin: "bbb",
    });
  });

  it("reports removed when only base pins it", async () => {
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce("aaa")
      .mockResolvedValueOnce(null);
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "removed",
      pin: "aaa",
    });
  });

  it("reports absent when neither ref pins it", async () => {
    vi.mocked(submoduleShaAt).mockResolvedValue(null);
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "absent",
    });
  });

  it("reports an error with its message when the pin lookup throws", async () => {
    vi.mocked(submoduleShaAt).mockRejectedValue("bad tree-ish");
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "error",
      message: "bad tree-ish",
    });
  });

  it("resolves a manual repo without an override to same-name", async () => {
    // Regression: the containment pane's resolveContext returned nothing here
    // while compare() and the diff used the same-name branches.
    expect(await resolveRepoRange(manual, "/main", "main", "feature")).toEqual({
      ok: true,
      path: "/manual",
      base: "main",
      compare: "feature",
      source: "same-name",
    });
  });

  it("reports no-refs for a manual repo while the toolbar is empty", async () => {
    expect(await resolveRepoRange(manual, "/main", "", "feature")).toEqual({
      ok: false,
      reason: "no-refs",
    });
  });

  it("reports missing when the clone lacks a commit the super repo pins", async () => {
    // A branch made in another git worktree pins a commit that only that
    // worktree's submodule store has.
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce("aaa")
      .mockResolvedValueOnce("bbb");
    vi.mocked(hasCommit).mockImplementation(async (_path, rev) => rev !== "bbb");
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "missing",
      missing: { compare: "bbb", source: "gitlink" },
    });
    expect(hasCommit).toHaveBeenCalledWith("/main/sub", "aaa");
    expect(hasCommit).toHaveBeenCalledWith("/main/sub", "bbb");
  });

  it("names both pins when the clone lacks both", async () => {
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce("aaa")
      .mockResolvedValueOnce("bbb");
    vi.mocked(hasCommit).mockResolvedValue(false);
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "missing",
      missing: { base: "aaa", compare: "bbb", source: "gitlink" },
    });
  });

  it("reports missing when a repo's own compare branch isn't in its clone", async () => {
    const r: RepoEntry = {
      ...sub,
      override: { startBranch: "develop", targetBranch: "feature/y" },
    };
    vi.mocked(hasCommit).mockImplementation(async (_path, rev) => rev !== "feature/y");
    expect(await resolveRepoRange(r, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "missing",
      missing: { compare: "feature/y", source: "override" },
    });
    expect(hasCommit).toHaveBeenCalledWith("/main/sub", "develop");
    expect(hasCommit).toHaveBeenCalledWith("/main/sub", "feature/y");
  });

  it("reports missing when a manual repo lacks the toolbar's base", async () => {
    vi.mocked(hasCommit).mockImplementation(async (_path, rev) => rev !== "main");
    expect(await resolveRepoRange(manual, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "missing",
      missing: { base: "main", source: "same-name" },
    });
  });

  it("accepts git's empty tree as a root commit's base, though it is no commit", async () => {
    // The graph diffs a root commit from the empty tree, as git itself does.
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const r: RepoEntry = {
      ...sub,
      override: { startBranch: emptyTree, targetBranch: "c0ffee1" },
    };
    vi.mocked(hasCommit).mockImplementation(async (_path, rev) => rev !== emptyTree);
    expect(await resolveRepoRange(r, "/main", "main", "feature")).toEqual({
      ok: true,
      path: "/main/sub",
      base: emptyTree,
      compare: "c0ffee1",
      source: "override",
    });
  });

  it("never checks the main repo's refs", async () => {
    await resolveRepoRange(main, "/main", "main", "feature");
    expect(hasCommit).not.toHaveBeenCalled();
  });

  it("checks no refs for a repo whose gap is decided before they are known", async () => {
    await resolveRepoRange(manual, "/main", "", "feature");
    for (const [basePin, comparePin] of [
      ["aaa", "aaa"],
      [null, "bbb"],
      ["aaa", null],
      [null, null],
    ]) {
      vi.mocked(submoduleShaAt)
        .mockResolvedValueOnce(basePin)
        .mockResolvedValueOnce(comparePin);
      expect((await resolveRepoRange(sub, "/main", "main", "feature")).ok).toBe(false);
    }
    expect(hasCommit).not.toHaveBeenCalled();
  });

  it("reports an error with its message when the existence check throws", async () => {
    vi.mocked(hasCommit).mockRejectedValue("bad rev");
    expect(await resolveRepoRange(manual, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "error",
      message: "bad rev",
    });
  });
});

describe("resolveRepoRanges", () => {
  it("resolves every repo and publishes the result", async () => {
    appState.repos = [main, manual];
    appState.startBranch = "main";
    appState.targetBranch = "feature";
    const ranges = await resolveRepoRanges();
    expect(ranges.map((r) => (r.ok ? r.source : r.reason))).toEqual([
      "toolbar",
      "same-name",
    ]);
    expect(appState.repoRanges).toBe(ranges);
  });

  it("shares one resolution until an input changes", async () => {
    appState.repos = [main, sub];
    appState.startBranch = "main";
    appState.targetBranch = "feature";
    vi.mocked(submoduleShaAt).mockResolvedValue("aaa");
    const first = resolveRepoRanges();
    expect(resolveRepoRanges()).toBe(first);
    await first;
    expect(submoduleShaAt).toHaveBeenCalledTimes(2);
    appState.refsRefresh = 1;
    await resolveRepoRanges();
    expect(submoduleShaAt).toHaveBeenCalledTimes(4);
  });

  it("falls back to main alone before the workspace is built", async () => {
    appState.repoPath = "/main";
    appState.startBranch = "a";
    appState.targetBranch = "b";
    expect(await resolveRepoRanges()).toEqual([
      { ok: true, path: "/main", base: "a", compare: "b", source: "toolbar" },
    ]);
  });

  it("publishes only the latest resolution", async () => {
    appState.repos = [main, sub];
    appState.startBranch = "main";
    appState.targetBranch = "feature";
    let release: (v: string | null) => void = () => {};
    vi.mocked(submoduleShaAt)
      .mockImplementationOnce(
        () => new Promise<string | null>((r) => (release = r)),
      )
      .mockResolvedValueOnce("c1")
      .mockResolvedValueOnce("b2")
      .mockResolvedValueOnce("c2");
    const first = resolveRepoRanges();
    appState.targetBranch = "feature2";
    const second = await resolveRepoRanges();
    release("b1");
    await first;
    expect(appState.repoRanges).toBe(second);
  });
});
