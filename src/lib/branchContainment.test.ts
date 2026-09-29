import { describe, it, expect, beforeEach, vi } from "vitest";

// branchContainment.ts drives the runes store, five Tauri bindings, the range
// resolver and compare(); all are stubbed. Specifiers resolve relative to this
// file (src/lib).
vi.mock("./store.svelte", () => ({ appState: {} }));
vi.mock("./git", () => ({
  containment: vi.fn(),
  commitLog: vi.fn(),
  commitLogExcluding: vi.fn(),
  commitContainmentDetail: vi.fn(),
  squashCheck: vi.fn(),
}));
vi.mock("./repoRange", () => ({ resolveRepoRanges: vi.fn() }));
vi.mock("./compare", () => ({ compare: vi.fn() }));

import {
  PAGE_SIZE,
  dropPickOutside,
  groupCounts,
  isRepoVisible,
  loadBranchContainment,
  loadMoreGroup,
  rowMark,
  selectBranchCommit,
  setShowMerged,
  showAllChanges,
  squashLanded,
  summarize,
  type VisibleGroup,
} from "./branchContainment";
import { appState } from "./store.svelte";
import {
  commitContainmentDetail,
  commitLog,
  commitLogExcluding,
  containment,
  squashCheck,
} from "./git";
import { resolveRepoRanges } from "./repoRange";
import { compare } from "./compare";
import type { BcGroup, Commit, Containment, RepoEntry, RepoRange, SquashCheck } from "./types";

const commit = (sha: string, parents: string[] = ["p"]): Commit => ({
  sha,
  short_sha: sha.slice(0, 7),
  parents,
  author: "a",
  time: 0,
  summary: sha,
  refs: [],
  body: "",
});
const marks = (m: Partial<Containment>): Containment => ({
  not_in_target: [],
  equivalent: [],
  ahead: 0,
  behind: 0,
  source_is_branch: true,
  ...m,
});
const range = (path: string, base: string, compare: string): RepoRange => ({
  ok: true,
  path,
  base,
  compare,
  source: "toolbar",
});
const repos: RepoEntry[] = [
  { path: "/main", kind: "main", displayName: "main" },
  { path: "/main/sub", kind: "submodule", displayName: "sub", parentGitlinkPath: "sub" },
];
const tick = () => new Promise((r) => setTimeout(r, 0));
const group = (g: Partial<BcGroup>): BcGroup => ({
  path: "/main",
  base: "main",
  compare: "feature",
  status: "ready",
  error: null,
  marks: marks({}),
  commits: [],
  hasMore: false,
  loadingMore: false,
  mergedBy: undefined,
  squash: null,
  ...g,
});
const names = { base: "main", compare: "feature" };

beforeEach(() => {
  for (const f of [containment, commitLog, commitLogExcluding, commitContainmentDetail, squashCheck, resolveRepoRanges, compare]) {
    vi.mocked(f).mockReset();
  }
  Object.assign(appState, {
    appMode: "compare",
    repoPath: "/main",
    repos,
    activeRepoIdx: null,
    workspaceLayout: "unified",
    bcGroups: {},
    bcSelected: null,
    bcSelectedDetail: null,
    bcDiffRange: null,
    bcShowMerged: false,
    selectedFile: null,
    files: [],
  });
});

describe("loadBranchContainment", () => {
  it("builds one group per resolved range, asking about compare's commits against base", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      range("/main", "main", "feature"),
      { ok: false, reason: "unchanged", pin: "x" },
    ]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    await loadBranchContainment();
    expect(containment).toHaveBeenCalledWith("/main", "feature", "main");
    expect(commitLogExcluding).toHaveBeenCalledWith("/main", "feature", "main", PAGE_SIZE, 0);
    expect(Object.keys(appState.bcGroups)).toEqual(["0"]);
    expect(appState.bcGroups[0].status).toBe("ready");
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c1"]);
    expect(commitContainmentDetail).not.toHaveBeenCalled();
  });

  it("looks up the introducing merge once nothing is left to merge", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitContainmentDetail).mockResolvedValue({
      in_target: true,
      introduced_by: commit("m1", ["b0", "f1"]),
    });
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    await loadBranchContainment();
    expect(commitContainmentDetail).toHaveBeenCalledWith("/main", "feature", "main");
    expect(appState.bcGroups[0].mergedBy?.sha).toBe("m1");
  });

  it("keeps a failing group from affecting the others", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      range("/main", "main", "feature"),
      range("/main/sub", "aaa", "bbb"),
    ]);
    vi.mocked(containment).mockImplementation((path) =>
      path === "/main/sub" ? Promise.reject("boom") : Promise.resolve(marks({ not_in_target: ["c1"], ahead: 1 })),
    );
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    await loadBranchContainment();
    expect(appState.bcGroups[0].status).toBe("ready");
    expect(appState.bcGroups[1].status).toBe("error");
    expect(appState.bcGroups[1].error).toContain("boom");
  });

  it("drops results from a load the inputs have moved past", async () => {
    let release: (m: Containment) => void = () => {};
    vi.mocked(resolveRepoRanges)
      .mockResolvedValueOnce([range("/main", "main", "old")])
      .mockResolvedValueOnce([range("/main", "main", "new")]);
    vi.mocked(containment)
      .mockImplementationOnce(() => new Promise<Containment>((r) => (release = r)))
      .mockResolvedValueOnce(marks({ not_in_target: ["n1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("n1")]);
    const first = loadBranchContainment();
    await tick();
    await loadBranchContainment();
    release(marks({ not_in_target: ["o1"], ahead: 1 }));
    await first;
    expect(appState.bcGroups[0].compare).toBe("new");
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["n1"]);
  });

  it("drops a picked commit when its range changes on reload and lists all changes again", async () => {
    // Review focus: a reload onto another range must not leave the old
    // commit's files on screen after its pick is gone.
    vi.mocked(resolveRepoRanges)
      .mockResolvedValueOnce([range("/main", "main", "feature")])
      .mockResolvedValueOnce([range("/main", "main", "other")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1", ["c0"])]);
    vi.mocked(commitContainmentDetail).mockResolvedValue({ in_target: false, introduced_by: null });
    await loadBranchContainment();
    selectBranchCommit(0, appState.bcGroups[0].commits[0]);
    vi.mocked(compare).mockClear();
    await loadBranchContainment();
    expect(appState.bcSelected).toBeNull();
    expect(appState.bcSelectedDetail).toBeNull();
    expect(appState.bcDiffRange).toBeNull();
    expect(compare).toHaveBeenCalledWith({ silent: true });
  });

  it("drops a picked commit when its repo's range disappears", async () => {
    vi.mocked(resolveRepoRanges)
      .mockResolvedValueOnce([range("/main", "main", "feature"), range("/main/sub", "aaa", "bbb")])
      .mockResolvedValueOnce([
        range("/main", "main", "feature"),
        { ok: false, reason: "unchanged", pin: "x" },
      ]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["s1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("s1", ["s0"])]);
    vi.mocked(commitContainmentDetail).mockResolvedValue({ in_target: false, introduced_by: null });
    await loadBranchContainment();
    selectBranchCommit(1, appState.bcGroups[1].commits[0]);
    vi.mocked(compare).mockClear();
    await loadBranchContainment();
    expect(Object.keys(appState.bcGroups)).toEqual(["0"]);
    expect(appState.bcSelected).toBeNull();
    expect(appState.bcDiffRange).toBeNull();
    expect(compare).toHaveBeenCalledWith({ silent: true });
  });

  it("keeps the rows and the pick while an unchanged range refreshes", async () => {
    // Review focus: a watcher refresh (a worktree save) must not blank the
    // table, drop the pick or re-run compare under the diff being read.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValueOnce(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValueOnce([commit("c1", ["c0"])]);
    vi.mocked(commitContainmentDetail).mockResolvedValue({ in_target: false, introduced_by: null });
    await loadBranchContainment();
    selectBranchCommit(0, appState.bcGroups[0].commits[0]);
    await tick();
    vi.mocked(compare).mockClear();

    let release: (m: Containment) => void = () => {};
    vi.mocked(containment).mockImplementationOnce(() => new Promise<Containment>((r) => (release = r)));
    vi.mocked(commitLogExcluding).mockResolvedValueOnce([commit("c2", ["c1"]), commit("c1", ["c0"])]);
    const reload = loadBranchContainment();
    await tick();
    // Mid-refresh nothing has been blanked.
    expect(appState.bcGroups[0].status).toBe("ready");
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c1"]);
    expect(appState.bcSelected?.commit.sha).toBe("c1");
    expect(appState.bcSelectedDetail).not.toBeNull();
    expect(appState.bcDiffRange).toEqual({ repoIdx: 0, start: "c0", target: "c1" });

    release(marks({ not_in_target: ["c2", "c1"], ahead: 2 }));
    await reload;
    // The fresh results land together, and the pick stays without a re-compare.
    expect(appState.bcGroups[0].marks?.ahead).toBe(2);
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c2", "c1"]);
    expect(appState.bcSelected?.commit.sha).toBe("c1");
    expect(appState.bcDiffRange?.target).toBe("c1");
    expect(compare).not.toHaveBeenCalled();
  });

  it("starts a group whose range changed as an empty loading group", async () => {
    vi.mocked(resolveRepoRanges)
      .mockResolvedValueOnce([range("/main", "main", "feature")])
      .mockResolvedValueOnce([range("/main", "main", "other")]);
    vi.mocked(containment).mockResolvedValueOnce(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValueOnce([commit("c1")]);
    await loadBranchContainment();
    vi.mocked(containment).mockImplementationOnce(() => new Promise<Containment>(() => {}));
    void loadBranchContainment();
    await tick();
    expect(appState.bcGroups[0]).toMatchObject({ compare: "other", status: "loading", commits: [] });
  });

  it("releases a page that was loading when its group refreshed", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 150 }));
    let release: (c: Commit[]) => void = () => {};
    vi.mocked(commitLogExcluding)
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`c${i}`)))
      .mockImplementationOnce(() => new Promise<Commit[]>((r) => (release = r)))
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`c${i}`)));
    await loadBranchContainment();
    const more = loadMoreGroup(0);
    await loadBranchContainment();
    release(Array.from({ length: 50 }, (_, i) => commit(`d${i}`)));
    await more;
    expect(appState.bcGroups[0].commits).toHaveLength(100);
    expect(appState.bcGroups[0].loadingMore).toBe(false);
  });

  it("clears a leftover file selection when there is nothing to compare", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([{ ok: false, reason: "no-refs" }]);
    appState.files = [{ path: "x", old_path: null, status: "modified", repoIdx: 0 }];
    await loadBranchContainment();
    expect(appState.bcGroups).toEqual({});
    expect(appState.files).toEqual([]);
  });
});

describe("paging and merged commits", () => {
  it("loads the next page from where the list ends", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 150 }));
    vi.mocked(commitLogExcluding)
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`c${i}`)))
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => commit(`d${i}`)));
    await loadBranchContainment();
    expect(appState.bcGroups[0].hasMore).toBe(true);
    await loadMoreGroup(0);
    expect(commitLogExcluding).toHaveBeenLastCalledWith("/main", "feature", "main", PAGE_SIZE, 100);
    expect(appState.bcGroups[0].commits).toHaveLength(150);
    expect(appState.bcGroups[0].hasMore).toBe(false);
  });

  it("lists what the introducing merge brought in when merged commits are shown", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitContainmentDetail).mockResolvedValue({
      in_target: true,
      introduced_by: commit("m1", ["b0", "f1"]),
    });
    vi.mocked(commitLogExcluding).mockResolvedValueOnce([]).mockResolvedValueOnce([commit("f1")]);
    await loadBranchContainment();
    await setShowMerged(true);
    expect(commitLogExcluding).toHaveBeenLastCalledWith("/main", "feature", "b0", PAGE_SIZE, 0);
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["f1"]);
  });

  it("falls back to compare's history when no merge is known", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    vi.mocked(commitLog).mockResolvedValue([commit("c1"), commit("old")]);
    await loadBranchContainment();
    await setShowMerged(true);
    expect(commitLog).toHaveBeenCalledWith("/main", "feature", false, PAGE_SIZE, 0);
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c1", "old"]);
  });

  it("ends with the rows of the last toggle when merged commits go on and off quickly", async () => {
    // Review focus: the stale "on" fetch lands last and must not win.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    let release: (c: Commit[]) => void = () => {};
    vi.mocked(commitLog).mockImplementationOnce(() => new Promise<Commit[]>((r) => (release = r)));
    await loadBranchContainment();
    const on = setShowMerged(true);
    const off = setShowMerged(false);
    await off;
    release([commit("c1"), commit("old")]);
    await on;
    expect(appState.bcShowMerged).toBe(false);
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c1"]);
  });

  it("drops a page that was loading when merged commits were toggled", async () => {
    // Review focus: the old list's page must not be appended to the new list's
    // first page (duplicate keys in the keyed row list).
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 150 }));
    let release: (c: Commit[]) => void = () => {};
    vi.mocked(commitLogExcluding)
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`c${i}`)))
      .mockImplementationOnce(() => new Promise<Commit[]>((r) => (release = r)));
    vi.mocked(commitLog).mockResolvedValue([commit("m1")]);
    await loadBranchContainment();
    const more = loadMoreGroup(0);
    expect(appState.bcGroups[0].loadingMore).toBe(true);
    await setShowMerged(true);
    // The abandoned page can no longer clear "Loading…", so the toggle does.
    expect(appState.bcGroups[0].loadingMore).toBe(false);
    release(Array.from({ length: 50 }, (_, i) => commit(`d${i}`)));
    await more;
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["m1"]);
    expect(appState.bcGroups[0].loadingMore).toBe(false);
  });

  it("fetches the new list for a group whose first page was still loading", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    let release: (c: Commit[]) => void = () => {};
    vi.mocked(commitLogExcluding).mockImplementationOnce(() => new Promise<Commit[]>((r) => (release = r)));
    vi.mocked(commitLog).mockResolvedValue([commit("c1"), commit("old")]);
    const load = loadBranchContainment();
    await tick();
    await setShowMerged(true);
    release([commit("c1")]);
    await load;
    expect(appState.bcGroups[0].status).toBe("ready");
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c1", "old"]);
  });
});

describe("picking a commit", () => {
  it("diffs the commit inside its own repo and goes back to all changes", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      range("/main", "main", "feature"),
      range("/main/sub", "aaa", "bbb"),
    ]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["s1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("s1", ["s0"])]);
    vi.mocked(commitContainmentDetail).mockResolvedValue({ in_target: false, introduced_by: null });
    await loadBranchContainment();
    selectBranchCommit(1, appState.bcGroups[1].commits[0]);
    expect(appState.bcDiffRange).toEqual({ repoIdx: 1, start: "s0", target: "s1" });
    expect(appState.bcSelected?.repoIdx).toBe(1);
    expect(compare).toHaveBeenCalledTimes(1);
    showAllChanges();
    expect(appState.bcDiffRange).toBeNull();
    expect(appState.bcSelected).toBeNull();
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it("diffs a root commit against the empty tree", () => {
    appState.bcGroups = { 0: group({}) };
    selectBranchCommit(0, commit("r1", []));
    expect(appState.bcDiffRange?.start).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("drops the pick when the view narrows to another repo", () => {
    appState.bcGroups = { 0: group({}), 1: group({ path: "/main/sub" }) };
    selectBranchCommit(1, commit("s1", ["s0"]));
    expect(dropPickOutside(1)).toBe(false);
    expect(appState.bcDiffRange?.repoIdx).toBe(1);
    expect(dropPickOutside(0)).toBe(true);
    expect(appState.bcDiffRange).toBeNull();
    expect(appState.bcSelected).toBeNull();
    expect(dropPickOutside(0)).toBe(false);
  });
});

describe("pure helpers", () => {
  it("counts patch-equivalent commits apart from unmerged ones", () => {
    expect(groupCounts(group({ marks: marks({ ahead: 5, equivalent: ["a", "b"], behind: 3 }) }))).toEqual({
      out: 3,
      patch: 2,
      behind: 3,
    });
  });

  it("marks a row", () => {
    const notIn = new Set(["a", "b"]);
    const equiv = new Set(["b"]);
    expect(rowMark("a", notIn, equiv)).toBe("out");
    expect(rowMark("b", notIn, equiv)).toBe("patch");
    expect(rowMark("z", notIn, equiv)).toBe("in");
  });

  it("follows the active tab in Tabs, and Focus in Unified", () => {
    // Review focus: with a submodule tab active the table must show that tab.
    Object.assign(appState, { workspaceLayout: "tabs", activeRepoIdx: 1 });
    expect([0, 1].map(isRepoVisible)).toEqual([false, true]);
    Object.assign(appState, { workspaceLayout: "unified", activeRepoIdx: null });
    expect([0, 1].map(isRepoVisible)).toEqual([true, true]);
    Object.assign(appState, { activeRepoIdx: 0 });
    expect([0, 1].map(isRepoVisible)).toEqual([true, false]);
  });
});

describe("summarize", () => {
  const pair = { base: "main", compare: "feature" };
  const vis = (idx: number, g: BcGroup): VisibleGroup => ({ idx, group: g, names });

  it("uses the single-group wording when one group is visible", () => {
    // Review focus: repos without a range have no group; one group left means
    // the single-group sentence.
    expect(summarize([vis(0, group({ marks: marks({ ahead: 3, behind: 2 }) }))], pair)).toEqual({
      kind: "unmerged",
      names,
      out: 3,
      patch: 0,
      behind: 2,
      repos: 1,
      failed: 0,
    });
    expect(summarize([vis(0, group({ marks: marks({ ahead: 2, equivalent: ["a", "b"] }) }))], pair)).toEqual({
      kind: "patches",
      names,
      patch: 2,
    });
    expect(summarize([vis(0, group({ mergedBy: null }))], pair)).toEqual({
      kind: "merged",
      names,
      mergedBy: null,
    });
  });

  it("passes an unknown introducing merge through instead of calling it a fast-forward", () => {
    // A failed lookup leaves mergedBy undefined; null is the real "no merge commit".
    expect(summarize([vis(0, group({ mergedBy: undefined }))], pair)).toStrictEqual({
      kind: "merged",
      names,
      mergedBy: undefined,
    });
  });

  it("totals several groups", () => {
    const a = vis(0, group({ marks: marks({ ahead: 3 }) }));
    const b = vis(1, group({ marks: marks({ ahead: 2, equivalent: ["x"] }) }));
    expect(summarize([a, b], pair)).toEqual({
      kind: "unmerged",
      names: pair,
      out: 4,
      patch: 1,
      behind: null,
      repos: 2,
      failed: 0,
    });
    expect(summarize([vis(0, group({})), vis(1, group({}))], pair)).toEqual({
      kind: "all-in",
      names: pair,
      repos: 2,
      failed: 0,
    });
  });

  it("totals the groups that answered and counts the ones that failed", () => {
    // Review focus: one unreadable repo must not hold the whole summary on
    // "Checking commits…" (nor inflate "across N repos").
    const failed = vis(1, group({ status: "error", error: "boom", marks: null }));
    expect(summarize([vis(0, group({})), failed], pair)).toEqual({
      kind: "all-in",
      names: pair,
      repos: 1,
      failed: 1,
    });
    expect(summarize([vis(0, group({ marks: marks({ ahead: 3 }) })), failed], pair)).toEqual({
      kind: "unmerged",
      names: pair,
      out: 3,
      patch: 0,
      behind: null,
      repos: 1,
      failed: 1,
    });
  });

  it("waits only while a group is loading and none has commits left", () => {
    const loading = vis(1, group({ status: "loading", marks: null }));
    expect(summarize([vis(0, group({})), loading], pair)).toEqual({ kind: "loading" });
    expect(summarize([vis(0, group({ marks: marks({ ahead: 2 }) })), loading], pair)).toEqual({
      kind: "unmerged",
      names: pair,
      out: 2,
      patch: 0,
      behind: null,
      repos: 1,
      failed: 0,
    });
  });

  it("covers empty, same, loading and failed states", () => {
    expect(summarize([], pair)).toEqual({ kind: "no-refs" });
    expect(summarize([vis(0, group({ compare: "main" }))], pair)).toEqual({ kind: "same" });
    expect(summarize([vis(0, group({ status: "loading" }))], pair)).toEqual({ kind: "loading" });
    expect(summarize([vis(0, group({ status: "error" }))], pair)).toEqual({ kind: "error" });
  });
});

describe("squash detection", () => {
  const sq = (verdict: "none" | "no-net-change" | "squash" | "content") => ({
    verdict,
    squash_commit: verdict === "squash" ? commit("s1") : null,
  });

  it("asks only for groups that still have unmerged commits", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      range("/main", "main", "feature"),
      range("/main/sub", "aaa", "bbb"),
    ]);
    vi.mocked(containment).mockImplementation((path) =>
      Promise.resolve(path === "/main" ? marks({ ahead: 0 }) : marks({ not_in_target: ["c1"], ahead: 1 })),
    );
    vi.mocked(commitContainmentDetail).mockResolvedValue({ in_target: true, introduced_by: null });
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    vi.mocked(squashCheck).mockResolvedValue(sq("squash"));
    await loadBranchContainment();
    expect(squashCheck).toHaveBeenCalledTimes(1);
    expect(squashCheck).toHaveBeenCalledWith("/main/sub", "bbb", "aaa");
    expect(appState.bcGroups[1].squash).toEqual(sq("squash"));
    expect(appState.bcGroups[0].squash).toBeNull();
  });

  it("counts squashed commits as in base", () => {
    const g = group({ marks: marks({ ahead: 3, equivalent: ["e"] }), squash: sq("squash") });
    expect(squashLanded(g)?.verdict).toBe("squash");
    expect(groupCounts(g)).toEqual({ out: 0, patch: 3, behind: 0 });
    expect(rowMark("x", new Set(["x"]), new Set(), true)).toBe("squash");
    expect(rowMark("x", new Set(["x"]), new Set(), false)).toBe("out");
    expect(squashLanded(group({ squash: sq("no-net-change") }))).toBeNull();
    expect(squashLanded(group({ squash: "checking" }))).toBeNull();
  });

  it("summarizes a squash, a content match and no net change", () => {
    const pair = { base: "main", compare: "feature" };
    const one = (g: BcGroup) => summarize([{ idx: 0, group: g, names }], pair);
    expect(one(group({ marks: marks({ ahead: 2 }), squash: sq("squash") }))).toEqual({
      kind: "squash",
      names,
      commit: commit("s1"),
    });
    expect(one(group({ marks: marks({ ahead: 2 }), squash: sq("content") }))).toEqual({ kind: "content", names });
    expect(one(group({ marks: marks({ ahead: 2 }), squash: sq("no-net-change") }))).toEqual({
      kind: "no-net-change",
      names,
    });
  });

  it("leaves the rows alone when the check fails", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    vi.mocked(squashCheck).mockRejectedValue("no git");
    await loadBranchContainment();
    expect(appState.bcGroups[0].squash).toBeNull();
    expect(groupCounts(appState.bcGroups[0])).toEqual({ out: 1, patch: 0, behind: 0 });
  });

  it("shows checking during a group's first check, with its rows still ●", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    let release: (c: SquashCheck) => void = () => {};
    vi.mocked(squashCheck).mockImplementationOnce(() => new Promise<SquashCheck>((r) => (release = r)));
    const load = loadBranchContainment();
    await tick();
    expect(appState.bcGroups[0].status).toBe("ready");
    expect(appState.bcGroups[0].squash).toBe("checking");
    expect(groupCounts(appState.bcGroups[0])).toEqual({ out: 1, patch: 0, behind: 0 });
    release(sq("squash"));
    await load;
    expect(appState.bcGroups[0].squash).toEqual(sq("squash"));
  });

  it("keeps a refreshed group's verdict while it is checked again", async () => {
    // Review focus: refsRefresh fires on every saved file. The table must not
    // flicker ◐ back to ● (or say "checking for squash…") while the new answer
    // is on its way, and a stored verdict must not stop the re-check: the
    // commits that just arrived may be exactly what it no longer covers.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment)
      .mockResolvedValueOnce(marks({ not_in_target: ["c1"], ahead: 1 }))
      .mockResolvedValueOnce(marks({ not_in_target: ["c2", "c1"], ahead: 2 }));
    vi.mocked(commitLogExcluding)
      .mockResolvedValueOnce([commit("c1")])
      .mockResolvedValueOnce([commit("c2"), commit("c1")]);
    let release: (c: SquashCheck) => void = () => {};
    vi.mocked(squashCheck)
      .mockResolvedValueOnce(sq("squash"))
      .mockImplementationOnce(() => new Promise<SquashCheck>((r) => (release = r)));
    await loadBranchContainment();
    expect(appState.bcGroups[0].squash).toEqual(sq("squash"));

    const reload = loadBranchContainment();
    await tick();
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c2", "c1"]);
    expect(squashCheck).toHaveBeenCalledTimes(2);
    expect(appState.bcGroups[0].squash).toEqual(sq("squash"));
    expect(groupCounts(appState.bcGroups[0])).toEqual({ out: 0, patch: 2, behind: 0 });

    release(sq("none"));
    await reload;
    expect(appState.bcGroups[0].squash).toEqual(sq("none"));
    expect(groupCounts(appState.bcGroups[0])).toEqual({ out: 2, patch: 0, behind: 0 });
  });

  it("drops a stored verdict once the fresh marks have no ● left, without checking again", async () => {
    // The judgment is on the fresh marks' own ● count: groupCounts folds a
    // stored verdict in, and an old answer must not outlive the commits it
    // described (it would read as a squash over what is now plain patches).
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment)
      .mockResolvedValueOnce(marks({ not_in_target: ["c1", "c2"], ahead: 2 }))
      .mockResolvedValueOnce(marks({ equivalent: ["c1", "c2"], ahead: 2 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1"), commit("c2")]);
    vi.mocked(squashCheck).mockResolvedValue(sq("squash"));
    await loadBranchContainment();
    expect(appState.bcGroups[0].squash).toEqual(sq("squash"));

    await loadBranchContainment();
    expect(squashCheck).toHaveBeenCalledTimes(1);
    expect(appState.bcGroups[0].squash).toBeNull();
    expect(groupCounts(appState.bcGroups[0])).toEqual({ out: 0, patch: 2, behind: 0 });
  });

  it("drops a verdict that arrives after the inputs moved on", async () => {
    vi.mocked(resolveRepoRanges)
      .mockResolvedValueOnce([range("/main", "main", "old")])
      .mockResolvedValueOnce([range("/main", "main", "new")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    let release: (c: SquashCheck) => void = () => {};
    vi.mocked(squashCheck)
      .mockImplementationOnce(() => new Promise<SquashCheck>((r) => (release = r)))
      .mockResolvedValueOnce(sq("none"));
    const first = loadBranchContainment();
    await tick();
    await loadBranchContainment();
    release(sq("squash"));
    await first;
    expect(appState.bcGroups[0].compare).toBe("new");
    expect(appState.bcGroups[0].squash).toEqual(sq("none"));
  });
});
