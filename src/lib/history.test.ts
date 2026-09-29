import { describe, it, expect, beforeEach, vi } from "vitest";

// history.ts drives the runes store and compare(); branchContainment.ts is kept
// real (its clearPick is what is under test) with its own imports stubbed.
// Specifiers resolve relative to this file (src/lib).
vi.mock("./store.svelte", () => ({ appState: {} }));
vi.mock("./compare", () => ({ compare: vi.fn() }));
vi.mock("./git", () => ({}));
vi.mock("./repoRange", () => ({ resolveRepoRanges: vi.fn() }));

import { popHistory, pushAndDrillToCommit, redoHistory } from "./history";
import { appState } from "./store.svelte";
import { compare } from "./compare";
import type { Commit, CompareCtx, RepoEntry } from "./types";

const repos: RepoEntry[] = [
  { path: "/main", kind: "main", displayName: "main" },
  { path: "/main/sub", kind: "submodule", displayName: "sub", parentGitlinkPath: "sub" },
];
const picked: Commit = {
  sha: "c1",
  short_sha: "c1",
  parents: ["c0"],
  author: "a",
  time: 0,
  summary: "c1",
  refs: [],
  body: "",
};
const ctx: CompareCtx = {
  appMode: "compare",
  compareMode: "branch",
  mode: "three-dot",
  startBranch: "main",
  targetBranch: "feature",
  selectedFilePath: null,
  activeRepoIdx: null,
  overrides: {},
};

// A super-repo commit picked in the commit table.
function pick(): void {
  appState.bcSelected = { repoIdx: 0, commit: picked };
  appState.bcSelectedDetail = { in_target: false, introduced_by: null };
  appState.bcDiffRange = { repoIdx: 0, start: "c0", target: "c1" };
}

// The pick compare() runs under: it outranks Focus, so it must be gone.
let pickAtCompare: unknown;

beforeEach(() => {
  Object.assign(appState, {
    appMode: "blame",
    compareMode: "branch",
    mode: "three-dot",
    startBranch: "main",
    targetBranch: "feature",
    selectedFile: null,
    activeRepoIdx: null,
    repos,
    history: [],
    forwardHistory: [],
  });
  pickAtCompare = "unset";
  vi.mocked(compare).mockReset();
  vi.mocked(compare).mockImplementation(async () => {
    pickAtCompare = appState.bcDiffRange;
  });
});

describe("history navigation and the commit-table pick", () => {
  it("drops a pick from another repo before listing a drilled submodule commit", () => {
    // Review focus (F6): the submodule drill leaves the toolbar pair alone,
    // so the super repo's pick would outrank the drill and list nothing.
    pick();
    pushAndDrillToCommit("s1", 1);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(pickAtCompare).toBeNull();
    expect(appState.bcSelected).toBeNull();
    expect(appState.bcSelectedDetail).toBeNull();
  });

  it("drops a pick before re-listing on Back and Forward", () => {
    Object.assign(appState, { appMode: "compare", targetBranch: "c1", history: [ctx] });
    pick();
    popHistory();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(pickAtCompare).toBeNull();
    expect(appState.bcSelected).toBeNull();

    pick();
    pickAtCompare = "unset";
    redoHistory();
    expect(compare).toHaveBeenCalledTimes(2);
    expect(pickAtCompare).toBeNull();
    expect(appState.bcSelected).toBeNull();
  });
});
