import { describe, it, expect, beforeEach, vi } from "vitest";

// history.ts drives the runes store and compare(); branchContainment.ts is kept
// real (its clearPick is what is under test) with its own imports stubbed.
// Specifiers resolve relative to this file (src/lib).
vi.mock("./store.svelte", () => ({ appState: {} }));
vi.mock("./compare", () => ({ compare: vi.fn() }));
vi.mock("./git", () => ({ commitLog: vi.fn() }));
vi.mock("./repoRange", () => ({ resolveRepoRanges: vi.fn() }));

import {
  backToHead,
  commitViewActive,
  popHistory,
  pushAndDrillToCommit,
  redoHistory,
} from "./history";
import { appState } from "./store.svelte";
import { compare } from "./compare";
import { commitLog } from "./git";
import { EMPTY_TREE } from "./emptyTree";
import type { BlameRev, Commit, CompareCtx, RepoEntry } from "./types";

const repos: RepoEntry[] = [
  { path: "/main", kind: "main", displayName: "main" },
  { path: "/main/sub", kind: "submodule", displayName: "sub", parentGitlinkPath: "sub" },
];
const commit = (sha: string, parents: string[]): Commit => ({
  sha,
  short_sha: sha.slice(0, 7),
  parents,
  author: "a",
  time: 0,
  summary: `subject of ${sha}`,
  refs: [],
  body: "",
});
const picked = commit("c1", ["c0"]);
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
const rev = (sha: string): BlameRev => ({
  target: { repoIdx: 0, path: "a.md" },
  rev: sha,
  path: "a.md",
  before: { sha: "b0000000", summary: "b" },
  line: 3,
});

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
    repoPath: "/main",
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
    error: null,
    commitView: null,
    blameTarget: { repoIdx: 0, path: "a.md" },
    blameRev: null,
    revealLine: null,
  });
  pickAtCompare = "unset";
  vi.mocked(compare).mockReset();
  vi.mocked(compare).mockImplementation(async () => {
    pickAtCompare = appState.bcDiffRange;
  });
  vi.mocked(commitLog).mockReset();
  vi.mocked(commitLog).mockImplementation(async (_path, ref) => [
    commit(`${ref}-full`, ["p0-full"]),
  ]);
});

describe("history navigation and the commit-table pick", () => {
  it("drops a pick from another repo before listing a drilled submodule commit", async () => {
    // Review focus (F6): the submodule drill leaves the toolbar pair alone,
    // so the super repo's pick would outrank the drill and list nothing.
    pick();
    await pushAndDrillToCommit("s1", 1, null);
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

describe("the Blame drill-in", () => {
  it("reads the commit and opens parent..commit on the blamed file", async () => {
    await pushAndDrillToCommit("a0339e32", 0, { path: "old/a.md", line: 7 });
    expect(commitLog).toHaveBeenCalledWith("/main", "a0339e32", false, 1, 0);
    expect(appState.appMode).toBe("compare");
    expect(appState.mode).toBe("two-dot");
    expect(appState.startBranch).toBe("p0-full");
    expect(appState.targetBranch).toBe("a0339e32-full");
    expect(appState.commitView).toEqual({
      repoIdx: 0,
      base: "p0-full",
      target: "a0339e32-full",
      commit: commit("a0339e32-full", ["p0-full"]),
      from: { path: "old/a.md", line: 7 },
    });
    expect(appState.revealLine).toEqual({ repoIdx: 0, path: "old/a.md", line: 7 });
    expect(compare).toHaveBeenCalledWith({ preservePath: "old/a.md", preserveRepoIdx: 0 });
    expect(appState.history).toHaveLength(1);
    expect(appState.history[0].appMode).toBe("blame");
  });

  it("diffs a root commit against the empty tree", async () => {
    vi.mocked(commitLog).mockResolvedValue([commit("r00t-full", [])]);
    await pushAndDrillToCommit("r00t", 0, null);
    expect(appState.startBranch).toBe(EMPTY_TREE);
    expect(appState.commitView?.base).toBe(EMPTY_TREE);
    expect(appState.revealLine).toBeNull();
  });

  it("drills a submodule commit on that repo's own refs", async () => {
    await pushAndDrillToCommit("s1", 1, { path: "x.cpp", line: 2 });
    expect(commitLog).toHaveBeenCalledWith("/main/sub", "s1", false, 1, 0);
    expect(appState.repos[1].override).toEqual({
      startBranch: "p0-full",
      targetBranch: "s1-full",
    });
    expect(appState.startBranch).toBe("main");
    expect(appState.activeRepoIdx).toBe(1);
    expect(commitViewActive()).toBe(true);
  });

  it("pushes nothing when the commit can't be read", async () => {
    vi.mocked(commitLog).mockRejectedValue("bad object");
    await pushAndDrillToCommit("dead", 0, null);
    expect(appState.history).toHaveLength(0);
    expect(appState.appMode).toBe("blame");
    expect(appState.error).toBe("couldn't open commit dead: bad object");
    expect(compare).not.toHaveBeenCalled();
  });

  it("shows the commit view only while the drilled range is on screen", async () => {
    await pushAndDrillToCommit("a0339e32", 0, null);
    expect(commitViewActive()).toBe(true);
    appState.targetBranch = "feature";
    expect(commitViewActive()).toBe(false);
    appState.targetBranch = "a0339e32-full";
    appState.appMode = "blame";
    expect(commitViewActive()).toBe(false);
  });

  it("drops the commit view when another repo tab is picked", async () => {
    await pushAndDrillToCommit("s1", 1, null);
    expect(commitViewActive()).toBe(true);
    appState.activeRepoIdx = 0;
    expect(commitViewActive()).toBe(false);
    appState.activeRepoIdx = 1;
    expect(commitViewActive()).toBe(true);

    await pushAndDrillToCommit("a0339e32", 0, null);
    expect(appState.activeRepoIdx).toBe(0);
    expect(commitViewActive()).toBe(true);
    appState.activeRepoIdx = 1;
    expect(commitViewActive()).toBe(false);
  });

  it("keeps the commit view in a single repo, where no tab is picked", async () => {
    appState.repos = [repos[0]];
    await pushAndDrillToCommit("a0339e32", 0, null);
    expect(appState.activeRepoIdx).toBeNull();
    expect(commitViewActive()).toBe(true);
  });

  it("Back returns to the older blame the drill left", async () => {
    appState.blameRev = rev("p1");
    await pushAndDrillToCommit("a0339e32", 0, null);
    // The drill leaves Blame: a later Blame starts at HEAD.
    expect(appState.blameRev).toBeNull();
    appState.blameTarget = { repoIdx: 0, path: "other.md" };
    popHistory();
    expect(appState.appMode).toBe("blame");
    expect(appState.blameTarget).toEqual({ repoIdx: 0, path: "a.md" });
    expect(appState.blameRev).toEqual(rev("p1"));
    expect(appState.commitView).toBeNull();
  });

  it("Back reopens the file in the repo it was in", () => {
    Object.assign(appState, {
      appMode: "compare",
      history: [{ ...ctx, selectedFilePath: "x.cpp", selectedFileRepoIdx: 1 }],
    });
    popHistory();
    expect(compare).toHaveBeenCalledWith({ preservePath: "x.cpp", preserveRepoIdx: 1 });
  });

  it("Forward re-enters the commit view", async () => {
    await pushAndDrillToCommit("a0339e32", 0, null);
    popHistory();
    expect(appState.commitView).toBeNull();
    redoHistory();
    expect(appState.commitView?.target).toBe("a0339e32-full");
  });
});

describe("backToHead", () => {
  it("pops every older-blame frame and stops at HEAD", () => {
    const blameCtx = (r: BlameRev | null): CompareCtx => ({
      ...ctx,
      appMode: "blame",
      blameTarget: { repoIdx: 0, path: "a.md" },
      blameRev: r,
    });
    Object.assign(appState, {
      history: [{ ...ctx }, blameCtx(null), blameCtx(rev("p1"))],
      blameRev: rev("p2"),
    });
    backToHead();
    expect(appState.blameRev).toBeNull();
    expect(appState.history).toHaveLength(1);
    expect(appState.forwardHistory).toHaveLength(2);
    expect(appState.appMode).toBe("blame");
  });
});
