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
vi.mock("./compare", () => ({
  compare: vi.fn(),
  listedRanges: vi.fn(),
  forgetListedRanges: vi.fn(),
}));

import {
  PAGE_SIZE,
  clearPick,
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
import { compare, forgetListedRanges, listedRanges } from "./compare";
import type {
  BcGroup,
  Commit,
  Containment,
  ContainmentDetail,
  RepoEntry,
  RepoRange,
  SquashCheck,
} from "./types";

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
  baseTip: null,
  compareTip: null,
  ...g,
});
const names = { base: "main", compare: "feature" };

beforeEach(() => {
  for (const f of [
    containment,
    commitLog,
    commitLogExcluding,
    commitContainmentDetail,
    squashCheck,
    resolveRepoRanges,
    compare,
    listedRanges,
    forgetListedRanges,
  ]) {
    vi.mocked(f).mockReset();
  }
  Object.assign(appState, {
    appMode: "compare",
    repoPath: "/main",
    startBranch: "main",
    targetBranch: "feature",
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

  it("ends on the inputs of a call made while an older load ran", async () => {
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
    expect(compare).toHaveBeenCalledTimes(1);
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
    expect(compare).toHaveBeenCalledTimes(1);
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
    let release: (m: Containment) => void = () => {};
    vi.mocked(containment).mockImplementationOnce(() => new Promise<Containment>((r) => (release = r)));
    const reload = loadBranchContainment();
    await tick();
    expect(appState.bcGroups[0]).toMatchObject({ compare: "other", status: "loading", commits: [] });
    // Let the load finish: one left running would hold off every later load.
    release(marks({ ahead: 0 }));
    await reload;
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

  it("drops a page whose click came before a refresh replaced the rows", async () => {
    // Review focus (F2): the click captures the refresh's session and the old
    // offset; appending its page to the fresh page 0 would repeat SHAs, which
    // the keyed row list rejects.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    let releaseMarks: (m: Containment) => void = () => {};
    vi.mocked(containment)
      .mockResolvedValueOnce(marks({ ahead: 150 }))
      .mockImplementationOnce(() => new Promise<Containment>((r) => (releaseMarks = r)));
    let releasePage: (c: Commit[]) => void = () => {};
    vi.mocked(commitLogExcluding)
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`c${i}`)))
      .mockImplementationOnce(() => new Promise<Commit[]>((r) => (releasePage = r)))
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`c${i}`)));
    await loadBranchContainment();
    const refresh = loadBranchContainment();
    await tick();
    const more = loadMoreGroup(0);
    releaseMarks(marks({ ahead: 150 }));
    await refresh;
    releasePage([commit("c99"), ...Array.from({ length: 49 }, (_, i) => commit(`d${i}`))]);
    await more;
    const shas = appState.bcGroups[0].commits.map((c) => c.sha);
    expect(shas).toHaveLength(100);
    expect(new Set(shas).size).toBe(shas.length);
    expect(appState.bcGroups[0].loadingMore).toBe(false);
  });

  it("clears a leftover file selection when there is nothing to compare", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([{ ok: false, reason: "no-refs" }]);
    appState.files = [{ path: "x", old_path: null, status: "modified", repoIdx: 0 }];
    await loadBranchContainment();
    expect(appState.bcGroups).toEqual({});
    expect(appState.files).toEqual([]);
    // The emptied list holds no ranges: the next ones are listed even if they
    // equal the last ones compare() listed.
    expect(forgetListedRanges).toHaveBeenCalled();
  });

  it("lists the files again when the ranges differ from those last listed", async () => {
    // Review focus (F7): the table follows the pickers at once; the file list
    // and its header must not go on describing the old range.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(listedRanges).mockReturnValue(JSON.stringify([range("/main", "main", "old")]));
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    await loadBranchContainment();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledWith({ silent: true, preservePath: null });
  });

  it("keeps the open file when it lists the files again", async () => {
    // Review focus (minor 4): a refresh that moves a gitlink pin must not
    // snap the diff to the first file.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(listedRanges).mockReturnValue(JSON.stringify([range("/main", "main", "old")]));
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    appState.selectedFile = { path: "src/a.cpp", old_path: null, status: "modified", repoIdx: 0 };
    await loadBranchContainment();
    expect(compare).toHaveBeenCalledWith({ silent: true, preservePath: "src/a.cpp" });
  });

  it("leaves the file list alone when it holds these ranges already", async () => {
    // Compared by value: a refresh resolves a fresh but equal array.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(listedRanges).mockReturnValue(JSON.stringify([range("/main", "main", "feature")]));
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    await loadBranchContainment();
    expect(compare).not.toHaveBeenCalled();
  });
});

describe("refreshes", () => {
  // Tip reads are one-commit logs; answer them from a ref → tip table.
  const tipsAt = (tips: Record<string, string>) =>
    vi.mocked(commitLog).mockImplementation(async (_path, ref, _all, limit) =>
      limit === 1 ? [commit(tips[ref] ?? `${ref}-tip`)] : [],
    );
  const none: SquashCheck = { verdict: "none", squash_commit: null };
  const squashed: SquashCheck = { verdict: "squash", squash_commit: commit("s1") };

  it("runs one more load for any number of calls made while one runs", async () => {
    // Review focus (F1): refsRefresh fires on every saved file; overlapping
    // loads would pile up git processes that nothing waits for.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    let release: (m: Containment) => void = () => {};
    vi.mocked(containment)
      .mockImplementationOnce(() => new Promise<Containment>((r) => (release = r)))
      .mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    const first = loadBranchContainment();
    await tick();
    await Promise.all([loadBranchContainment(), loadBranchContainment(), loadBranchContainment()]);
    expect(resolveRepoRanges).toHaveBeenCalledTimes(1);
    release(marks({ ahead: 0 }));
    await first;
    expect(resolveRepoRanges).toHaveBeenCalledTimes(2);
    expect(containment).toHaveBeenCalledTimes(2);
    await loadBranchContainment();
    expect(resolveRepoRanges).toHaveBeenCalledTimes(3);
  });

  it("starts a load for a new pair at once and drops the load it replaces", async () => {
    // Review focus (NB1): the old range's rows must not land under the new
    // range's labels, nor hold off the new load (and its file list) until the
    // old one ends.
    vi.mocked(resolveRepoRanges)
      .mockResolvedValueOnce([range("/main", "main", "feature-x")])
      .mockResolvedValueOnce([range("/main", "main", "feature-y")]);
    let release: (m: Containment) => void = () => {};
    vi.mocked(containment)
      .mockImplementationOnce(() => new Promise<Containment>((r) => (release = r)))
      .mockResolvedValueOnce(marks({ not_in_target: ["y1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("y1")]);
    vi.mocked(squashCheck).mockResolvedValue(none);
    appState.targetBranch = "feature-x";
    const old = loadBranchContainment();
    await tick();
    vi.mocked(compare).mockClear();

    appState.targetBranch = "feature-y";
    await loadBranchContainment();
    expect(resolveRepoRanges).toHaveBeenCalledTimes(2);
    expect(appState.bcGroups[0]).toMatchObject({ compare: "feature-y", status: "ready" });
    // The new range's files are listed now, not once the old load ends.
    expect(compare).toHaveBeenCalledTimes(1);

    vi.mocked(commitLogExcluding).mockClear();
    release(marks({ not_in_target: ["x1"], ahead: 1 }));
    await old;
    // The replaced load stopped at its first check: no page, no landing.
    expect(commitLogExcluding).not.toHaveBeenCalled();
    expect(appState.bcGroups[0].marks?.not_in_target).toEqual(["y1"]);
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["y1"]);
  });

  it("reloads a kept group whose squash check a replaced load abandoned", async () => {
    // The submodule's pins are the same under both pairs, so the new load
    // keeps its group; the old check can no longer land, and the group must
    // not be skipped with "checking" (or an old verdict) left on it.
    const sub: RepoRange = { ok: true, path: "/main/sub", base: "aaa", compare: "bbb", source: "gitlink" };
    vi.mocked(resolveRepoRanges)
      .mockResolvedValueOnce([range("/main", "main", "feature-x"), sub])
      .mockResolvedValueOnce([range("/main", "main", "feature-y"), sub]);
    vi.mocked(containment).mockImplementation(async (path) =>
      path === "/main/sub" ? marks({ not_in_target: ["s1"], ahead: 1 }) : marks({ ahead: 0 }),
    );
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    let release: (c: SquashCheck) => void = () => {};
    vi.mocked(squashCheck)
      .mockImplementationOnce(() => new Promise<SquashCheck>((r) => (release = r)))
      .mockResolvedValueOnce(none);
    appState.targetBranch = "feature-x";
    const old = loadBranchContainment();
    await tick();
    expect(appState.bcGroups[1].squash).toBe("checking");

    appState.targetBranch = "feature-y";
    await loadBranchContainment();
    expect(vi.mocked(containment).mock.calls.filter((c) => c[0] === "/main/sub")).toHaveLength(2);
    expect(appState.bcGroups[1]).toMatchObject({ squash: none, baseTip: "aaa", compareTip: "bbb" });

    release(squashed);
    await old;
    expect(appState.bcGroups[1]).toMatchObject({ squash: none, baseTip: "aaa", compareTip: "bbb" });
  });

  it("lists no files for a load that ends after Branch mode was left", async () => {
    // Review focus (minor 2): Working Copy shares selectedFile, which a
    // re-list would seed again.
    let release: (r: RepoRange[]) => void = () => {};
    vi.mocked(resolveRepoRanges).mockImplementationOnce(
      () => new Promise<RepoRange[]>((r) => (release = r)),
    );
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    const load = loadBranchContainment();
    appState.appMode = "changes";
    release([range("/main", "main", "feature")]);
    await load;
    expect(compare).not.toHaveBeenCalled();
  });

  it("drops a pick without listing files once Branch mode was left", async () => {
    // Both ways a load drops a pick: its range changed, or its reloaded group
    // no longer holds it.
    appState.bcGroups = { 0: group({ compare: "old" }) };
    selectBranchCommit(0, commit("c1", ["c0"]));
    vi.mocked(compare).mockClear();
    let release: (r: RepoRange[]) => void = () => {};
    vi.mocked(resolveRepoRanges).mockImplementationOnce(
      () => new Promise<RepoRange[]>((r) => (release = r)),
    );
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    const load = loadBranchContainment();
    appState.appMode = "changes";
    release([range("/main", "main", "feature")]);
    await load;
    expect(appState.bcSelected).toBeNull();
    expect(compare).not.toHaveBeenCalled();

    // Kept range, but the reloaded group no longer holds the pick.
    appState.appMode = "compare";
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    tipsAt({ main: "b1", feature: "f1" });
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1", ["c0"])]);
    vi.mocked(squashCheck).mockResolvedValue(none);
    await loadBranchContainment();
    selectBranchCommit(0, appState.bcGroups[0].commits[0]);
    tipsAt({ main: "b1", feature: "f2" });
    let releaseMarks: (m: Containment) => void = () => {};
    vi.mocked(containment).mockImplementationOnce(
      () => new Promise<Containment>((r) => (releaseMarks = r)),
    );
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1b", ["c0"])]);
    const reload = loadBranchContainment();
    await tick();
    vi.mocked(compare).mockClear();
    appState.appMode = "changes";
    releaseMarks(marks({ not_in_target: ["c1b"], ahead: 1 }));
    await reload;
    expect(appState.bcSelected).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  it("clears no selection for a load that finds nothing after Branch mode was left", async () => {
    const file = { path: "a.txt", old_path: null, status: "modified" as const, repoIdx: 0 };
    appState.selectedFile = file;
    let release: (r: RepoRange[]) => void = () => {};
    vi.mocked(resolveRepoRanges).mockImplementationOnce(
      () => new Promise<RepoRange[]>((r) => (release = r)),
    );
    const load = loadBranchContainment();
    appState.appMode = "changes";
    release([{ ok: false, reason: "no-refs" }]);
    await load;
    expect(appState.selectedFile).toBe(file);
    expect(forgetListedRanges).not.toHaveBeenCalled();
  });

  it("drops the load asked for meanwhile once Branch mode is left", async () => {
    // The table is off screen; its groups (and a pick) stay for the way back
    // instead of being cleared by a load nobody is looking at.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    let release: (m: Containment) => void = () => {};
    vi.mocked(containment).mockImplementationOnce(
      () => new Promise<Containment>((r) => (release = r)),
    );
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    const first = loadBranchContainment();
    await tick();
    void loadBranchContainment();
    appState.appMode = "changes";
    release(marks({ ahead: 0 }));
    await first;
    expect(resolveRepoRanges).toHaveBeenCalledTimes(1);
    expect(appState.bcGroups[0]?.status).toBe("ready");
  });

  it("skips a group whose tips did not move, keeping its rows and verdict", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    tipsAt({ main: "b1", feature: "f1" });
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    vi.mocked(squashCheck).mockResolvedValue(squashed);
    await loadBranchContainment();
    expect(appState.bcGroups[0]).toMatchObject({ baseTip: "b1", compareTip: "f1", squash: squashed });
    const kept = appState.bcGroups[0];
    for (const f of [containment, commitLog, commitLogExcluding, squashCheck]) vi.mocked(f).mockClear();

    await loadBranchContainment();
    expect(commitLog).toHaveBeenCalledWith("/main", "main", false, 1, 0);
    expect(commitLog).toHaveBeenCalledWith("/main", "feature", false, 1, 0);
    expect(containment).not.toHaveBeenCalled();
    expect(commitLogExcluding).not.toHaveBeenCalled();
    expect(squashCheck).not.toHaveBeenCalled();
    expect(appState.bcGroups[0]).toBe(kept);
  });

  it("reloads and checks for a squash again once compare's tip moved", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    tipsAt({ main: "b1", feature: "f1" });
    vi.mocked(containment)
      .mockResolvedValueOnce(marks({ not_in_target: ["c1"], ahead: 1 }))
      .mockResolvedValueOnce(marks({ not_in_target: ["c2", "c1"], ahead: 2 }));
    vi.mocked(commitLogExcluding)
      .mockResolvedValueOnce([commit("c1")])
      .mockResolvedValueOnce([commit("c2"), commit("c1")]);
    vi.mocked(squashCheck).mockResolvedValueOnce(squashed).mockResolvedValueOnce(none);
    await loadBranchContainment();

    tipsAt({ main: "b1", feature: "f2" });
    await loadBranchContainment();
    expect(containment).toHaveBeenCalledTimes(2);
    expect(squashCheck).toHaveBeenCalledTimes(2);
    expect(appState.bcGroups[0]).toMatchObject({ compareTip: "f2", squash: none });
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c2", "c1"]);
  });

  it("takes a gitlink range's pins as its tips without reading them", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      range("/main", "main", "feature"),
      { ok: true, path: "/main/sub", base: "aaa", compare: "bbb", source: "gitlink" },
    ]);
    tipsAt({ main: "b1", feature: "f1" });
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    await loadBranchContainment();
    expect(appState.bcGroups[1]).toMatchObject({ baseTip: "aaa", compareTip: "bbb" });
    expect(vi.mocked(commitLog).mock.calls.every((c) => c[0] === "/main")).toBe(true);

    await loadBranchContainment();
    expect(containment).toHaveBeenCalledTimes(2);
  });

  it("reloads a group that failed, even when its tips did not move", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    tipsAt({ main: "b1", feature: "f1" });
    vi.mocked(containment).mockRejectedValueOnce("boom").mockResolvedValueOnce(marks({ ahead: 0 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    await loadBranchContainment();
    expect(appState.bcGroups[0].status).toBe("error");
    await loadBranchContainment();
    expect(containment).toHaveBeenCalledTimes(2);
    expect(appState.bcGroups[0].status).toBe("ready");
  });

  it("appends a page that lands after a refresh skipped its group", async () => {
    // The skipped group keeps its rows, so the page still continues them —
    // and ends its own "Loading…", since no reload lands to do it.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    tipsAt({ main: "b1", feature: "f1" });
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
    expect(commitLogExcluding).toHaveBeenCalledTimes(2);
    expect(appState.bcGroups[0].commits).toHaveLength(150);
    expect(appState.bcGroups[0].loadingMore).toBe(false);
  });

  it("reloads the new list when a refresh drops a toggle's refetch", async () => {
    // The refresh's session drops the refetch; skipping the group by its tips
    // would then leave the old list's rows under the new checkbox.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    let release: (c: Commit[]) => void = () => {};
    let pages = 0;
    vi.mocked(commitLog).mockImplementation((_path, ref, _all, limit) => {
      if (limit === 1) return Promise.resolve([commit(`${ref}-tip`)]);
      pages++;
      return pages === 1
        ? new Promise<Commit[]>((r) => (release = r))
        : Promise.resolve([commit("c1"), commit("old")]);
    });
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    vi.mocked(squashCheck).mockResolvedValue(none);
    await loadBranchContainment();
    const toggle = setShowMerged(true);
    await loadBranchContainment();
    release([commit("c1")]);
    await toggle;
    expect(appState.bcShowMerged).toBe(true);
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c1", "old"]);
  });
});

describe("a pick across refreshes", () => {
  const tipsAt = (feature: string) =>
    vi.mocked(commitLog).mockImplementation(async (_path, ref, _all, limit) =>
      limit === 1 ? [commit(ref === "feature" ? feature : "b1")] : [],
    );
  const notIn = { in_target: false, introduced_by: null };

  // One group, main ← feature, whose only row c1 is picked.
  async function loadAndPick(): Promise<void> {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    tipsAt("f1");
    vi.mocked(containment).mockResolvedValueOnce(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValueOnce([commit("c1", ["c0"])]);
    vi.mocked(squashCheck).mockResolvedValue({ verdict: "none", squash_commit: null });
    vi.mocked(commitContainmentDetail).mockResolvedValue(notIn);
    await loadBranchContainment();
    selectBranchCommit(0, appState.bcGroups[0].commits[0]);
    await tick();
    vi.mocked(compare).mockClear();
    vi.mocked(commitContainmentDetail).mockClear();
  }

  it("drops a pick the reloaded group no longer holds and lists all changes", async () => {
    // Review focus (F3): amending compare's tip leaves c1 on neither branch;
    // it must not stay picked and read "in main".
    await loadAndPick();
    tipsAt("f2");
    vi.mocked(containment).mockResolvedValueOnce(marks({ not_in_target: ["c1b"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValueOnce([commit("c1b", ["c0"])]);
    await loadBranchContainment();
    expect(appState.bcSelected).toBeNull();
    expect(appState.bcDiffRange).toBeNull();
    expect(compare).toHaveBeenCalledWith({ silent: true });
  });

  it("keeps a pick the reloaded group still holds and looks up its detail again", async () => {
    // c1 is one of the group's ● commits though not on the first page.
    await loadAndPick();
    tipsAt("f2");
    vi.mocked(containment).mockResolvedValueOnce(marks({ not_in_target: ["c2", "c1"], ahead: 2 }));
    vi.mocked(commitLogExcluding).mockResolvedValueOnce([commit("c2", ["c1"])]);
    await loadBranchContainment();
    await tick();
    expect(appState.bcSelected?.commit.sha).toBe("c1");
    expect(appState.bcDiffRange?.target).toBe("c1");
    expect(commitContainmentDetail).toHaveBeenCalledWith("/main", "c1", "main");
    expect(appState.bcSelectedDetail).toEqual(notIn);
    expect(compare).not.toHaveBeenCalled();
  });

  it("keeps a pick as it is when its group's tips did not move", async () => {
    await loadAndPick();
    const detail = appState.bcSelectedDetail;
    await loadBranchContainment();
    await tick();
    expect(appState.bcSelected?.commit.sha).toBe("c1");
    expect(appState.bcSelectedDetail).toBe(detail);
    expect(commitContainmentDetail).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it("applies a pick's detail that lands after a refresh started", async () => {
    // A refresh starts a new session; the pick itself is what the detail is for.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    tipsAt("f1");
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1", ["c0"])]);
    vi.mocked(squashCheck).mockResolvedValue({ verdict: "none", squash_commit: null });
    let release: (d: ContainmentDetail) => void = () => {};
    vi.mocked(commitContainmentDetail).mockImplementationOnce(
      () => new Promise<ContainmentDetail>((r) => (release = r)),
    );
    await loadBranchContainment();
    selectBranchCommit(0, appState.bcGroups[0].commits[0]);
    await loadBranchContainment();
    release(notIn);
    await tick();
    expect(appState.bcSelectedDetail).toEqual(notIn);
  });

  it("keeps the newest detail when an older lookup for the same pick lands last", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    tipsAt("f1");
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1", ["c0"])]);
    vi.mocked(squashCheck).mockResolvedValue({ verdict: "none", squash_commit: null });
    let release: (d: ContainmentDetail) => void = () => {};
    const inBase = { in_target: true, introduced_by: null };
    vi.mocked(commitContainmentDetail)
      .mockImplementationOnce(() => new Promise<ContainmentDetail>((r) => (release = r)))
      .mockResolvedValueOnce(inBase);
    await loadBranchContainment();
    selectBranchCommit(0, appState.bcGroups[0].commits[0]);
    // compare moved but still holds c1: the reload looks its detail up again.
    tipsAt("f2");
    await loadBranchContainment();
    await tick();
    release(notIn);
    await tick();
    expect(appState.bcSelectedDetail).toEqual(inBase);
  });

  it("drops a detail that lands after the pick moved to another repo", async () => {
    appState.bcGroups = { 0: group({}), 1: group({ path: "/main/sub" }) };
    let release: (d: ContainmentDetail) => void = () => {};
    vi.mocked(commitContainmentDetail)
      .mockImplementationOnce(() => new Promise<ContainmentDetail>((r) => (release = r)))
      .mockResolvedValueOnce(notIn);
    selectBranchCommit(1, commit("c1", ["c0"]));
    selectBranchCommit(0, commit("c1", ["c0"]));
    await tick();
    release({ in_target: true, introduced_by: null });
    await tick();
    expect(appState.bcSelectedDetail).toEqual(notIn);
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

  it("ends the default list once its rows reach the ahead count", async () => {
    // A full last page no longer offers "Load 100 more (0 left)".
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 200 }));
    vi.mocked(commitLogExcluding)
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`c${i}`)))
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`d${i}`)));
    await loadBranchContainment();
    expect(appState.bcGroups[0].hasMore).toBe(true);
    await loadMoreGroup(0);
    expect(appState.bcGroups[0].commits).toHaveLength(200);
    expect(appState.bcGroups[0].hasMore).toBe(false);
  });

  it("offers no more rows when the first page holds every unmerged commit", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 100 }));
    vi.mocked(commitLogExcluding).mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => commit(`c${i}`)),
    );
    await loadBranchContainment();
    expect(appState.bcGroups[0].hasMore).toBe(false);
  });

  it("pages a merged-commits list while its pages come back full", async () => {
    // compare's history has no known length; the default list is back to its
    // ahead count once the toggle is off.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    vi.mocked(commitLog).mockImplementation(async (_path, ref, _all, limit) =>
      limit === 1 ? [commit(`${ref}-tip`)] : Array.from({ length: 100 }, (_, i) => commit(`m${i}`)),
    );
    await loadBranchContainment();
    await setShowMerged(true);
    expect(appState.bcGroups[0].hasMore).toBe(true);
    await setShowMerged(false);
    expect(appState.bcGroups[0].hasMore).toBe(false);
  });

  it("appends a page that overlaps the rows without repeating a SHA", async () => {
    // compare's history can shift between two pages.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 150 }));
    vi.mocked(commitLogExcluding)
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`c${i}`)))
      .mockResolvedValueOnce([
        commit("c98"),
        commit("c99"),
        ...Array.from({ length: 48 }, (_, i) => commit(`d${i}`)),
      ]);
    await loadBranchContainment();
    await loadMoreGroup(0);
    const shas = appState.bcGroups[0].commits.map((c) => c.sha);
    expect(shas).toHaveLength(148);
    expect(new Set(shas).size).toBe(148);
    expect(shas.slice(98, 101)).toEqual(["c98", "c99", "d0"]);
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
    await loadBranchContainment();
    let release: (c: Commit[]) => void = () => {};
    vi.mocked(commitLog).mockImplementationOnce(() => new Promise<Commit[]>((r) => (release = r)));
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
    vi.mocked(compare).mockClear();
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

  it("drops a pick without listing anything itself", () => {
    appState.bcGroups = { 0: group({}) };
    selectBranchCommit(0, commit("c1", ["c0"]));
    appState.bcSelectedDetail = { in_target: false, introduced_by: null };
    vi.mocked(compare).mockClear();
    clearPick();
    expect(appState.bcSelected).toBeNull();
    expect(appState.bcSelectedDetail).toBeNull();
    expect(appState.bcDiffRange).toBeNull();
    expect(compare).not.toHaveBeenCalled();
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

  it("names several groups by the toolbar pair, shortened", () => {
    // A drill-in's `<sha>^ ← <sha>` would otherwise print two 40-hex SHAs.
    const sha = "a41f2c9d0e1b2c3d4e5f60718293a4b5c6d7e8f9";
    const drill = { base: `${sha}^`, compare: sha };
    const short = { base: "a41f2c9^", compare: "a41f2c9" };
    expect(summarize([vis(0, group({})), vis(1, group({}))], drill)).toEqual({
      kind: "all-in",
      names: short,
      repos: 2,
      failed: 0,
    });
    const out = summarize([vis(0, group({ marks: marks({ ahead: 1 }) })), vis(1, group({}))], drill);
    expect(out).toMatchObject({ kind: "unmerged", names: short });
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

  it("ends on the new range's verdict when the inputs move during a check", async () => {
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
