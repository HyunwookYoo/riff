import { describe, it, expect, beforeEach, vi } from "vitest";

// compare() pulls in the runes store, the Tauri bindings, the range resolver
// and a few UI helpers at module load; none matter to which repos it scans, so
// they are stubbed. Specifiers resolve relative to this file (src/lib).
vi.mock("./store.svelte", () => ({
  appState: {
    repoPath: "/main",
    workspaceLayout: "unified",
    compareMode: "branch",
    activeRepoIdx: null,
    repos: [],
    startBranch: "main",
    targetBranch: "feature",
    mode: "three-dot",
    ignoreWhitespace: false,
    error: null,
    loadingFiles: false,
    files: [],
    selectedFile: null,
    bcDiffRange: null,
  },
}));
vi.mock("./git", () => ({ diffFiles: vi.fn() }));
vi.mock("./repoRange", () => ({ resolveRepoRanges: vi.fn() }));
vi.mock("./diff/lang", () => ({ detectLanguage: () => null }));
vi.mock("./diff/shiki", () => ({ preloadLanguages: vi.fn() }));
vi.mock("./commitHistory", () => ({ restoreCompareContext: vi.fn() }));
vi.mock("./workingCopy", () => ({ enterChangesMode: vi.fn() }));

import { compare, forgetListedRanges, listedRanges } from "./compare";
import { appState } from "./store.svelte";
import { diffFiles } from "./git";
import { resolveRepoRanges } from "./repoRange";
import type { ChangedFile, RepoEntry, RepoRange } from "./types";

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

const ok = (path: string, base: string, compare: string): RepoRange => ({
  ok: true,
  path,
  base,
  compare,
  source: "toolbar",
});
const allOk = [
  ok("/main", "main", "feature"),
  ok("/main/sub", "aaa", "bbb"),
  ok("/manual", "main", "feature"),
];

beforeEach(() => {
  // compare() batches file arrivals per animation frame; run them at once.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.mocked(diffFiles).mockReset();
  vi.mocked(diffFiles).mockImplementation(async (...args) => {
    const onFile = args[5];
    onFile({
      path: "x.cpp",
      old_path: null,
      status: "modified",
      repoIdx: 0,
    } as ChangedFile);
  });
  vi.mocked(resolveRepoRanges).mockReset();
  appState.repos = [main, sub, manual];
  appState.activeRepoIdx = null;
  appState.bcDiffRange = null;
  appState.files = [];
  appState.selectedFile = null;
  appState.error = null;
});

describe("compare", () => {
  it("diffs a picked submodule commit inside that submodule", async () => {
    // The drill bug: with Focus on the submodule, picking one of its commits
    // used to scan nothing and leave the file list empty.
    vi.mocked(resolveRepoRanges).mockResolvedValue(allOk);
    appState.activeRepoIdx = 1;
    appState.bcDiffRange = { repoIdx: 1, start: "p1", target: "c1" };
    await compare();
    expect(vi.mocked(diffFiles).mock.calls.map((c) => c.slice(0, 4))).toEqual([
      ["/main/sub", "p1", "c1", "two-dot"],
    ]);
    expect(appState.files.map((f) => f.repoIdx)).toEqual([1]);
  });

  it("diffs a picked main commit only in main", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue(allOk);
    appState.bcDiffRange = { repoIdx: 0, start: "p0", target: "c0" };
    await compare();
    expect(vi.mocked(diffFiles).mock.calls.map((c) => c.slice(0, 4))).toEqual([
      ["/main", "p0", "c0", "two-dot"],
    ]);
  });

  it("scans each repo's resolved range and skips repos without one", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      ok("/main", "main", "feature"),
      { ok: false, reason: "unchanged", pin: "aaa" },
      ok("/manual", "main", "feature"),
    ]);
    await compare();
    expect(vi.mocked(diffFiles).mock.calls.map((c) => c.slice(0, 4))).toEqual([
      ["/main", "main", "feature", "three-dot"],
      ["/manual", "main", "feature", "three-dot"],
    ]);
    expect(appState.files.map((f) => f.repoIdx)).toEqual([0, 2]);
  });

  it("scans only the focused repo in Unified view", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue(allOk);
    appState.activeRepoIdx = 2;
    await compare();
    expect(vi.mocked(diffFiles).mock.calls.map((c) => c[0])).toEqual([
      "/manual",
    ]);
  });

  it("remembers the ranges it listed, and none while it lists a picked commit", async () => {
    // loadBranchContainment re-lists when the ranges on screen differ (F7).
    vi.mocked(resolveRepoRanges).mockResolvedValue(allOk);
    await compare();
    expect(listedRanges()).toBe(JSON.stringify(allOk));
    appState.bcDiffRange = { repoIdx: 0, start: "p0", target: "c0" };
    await compare();
    expect(listedRanges()).toBeNull();
  });

  it("forgets the ranges it listed once the list is emptied elsewhere", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue(allOk);
    await compare();
    forgetListedRanges();
    expect(listedRanges()).toBeNull();
  });
});
