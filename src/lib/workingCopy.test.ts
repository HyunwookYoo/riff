import { describe, expect, it, vi, beforeEach } from "vitest";

// workingCopy.ts imports the runes store (and, transitively via commitHistory,
// the Tauri `invoke` wrappers in git.ts) at module load. headRelativeStatus and
// mergeDuplicatePaths are pure functions of their StatusEntry argument, so an
// empty stub was enough for those — see workspace.test.ts for the same pattern.
// doFetch/doPull below actually dispatch through ./git, so appState needs the
// fields they read/write and ./git needs real vi.fn()s to assert against.
vi.mock("./store.svelte", () => ({
  appState: {
    repoPath: "",
    repos: [],
    changesRepoIdx: 0,
    syncing: false,
    error: null,
    currentBranch: null,
    currentUpstream: null,
    currentAhead: 0,
    currentBehind: 0,
    appMode: "changes",
    refsRefresh: 0,
    repoStatus: null,
    beginGitOp: () => {},
    endGitOp: () => {},
  },
}));
vi.mock("./git", () => ({
  fetch: vi.fn(),
  pull: vi.fn(),
  opAbort: vi.fn(),
  opContinue: vi.fn(),
  pendingOp: vi.fn(),
  status: vi.fn(),
}));

import {
  doFetch,
  doPull,
  headRelativeStatus,
  mergeDuplicatePaths,
  workingCopyOrder,
} from "./workingCopy";
import { appState } from "./store.svelte";
import { fetch as fetchCmd, pull as pullCmd, status } from "./git";
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

  it("reads a staged add whose disk copy was removed as added, not deleted", () => {
    // `git add g.txt && rm g.txt`: g.txt was never in HEAD, so there is no
    // HEAD blob to call "deleted" against even though Y says the disk copy
    // is gone too.
    expect(headRelativeStatus(entry("A", "D"))).toBe("added");
  });
});

describe("mergeDuplicatePaths", () => {
  it("collapses git rm --cached's two records for one path into one modified row", () => {
    // `git rm --cached f.txt` (disk copy left alone) makes porcelain v2 emit
    // two records for the same path:
    //   1 D. N... 100644 000000 000000 45b983b 0000000 f.txt
    //   ? f.txt
    const tracked = entry("D", ".");
    const untracked = entry("?", "?");
    const merged = mergeDuplicatePaths([tracked, untracked]);
    expect(merged.length).toBe(1);
    expect(merged[0].path).toBe(tracked.path);
    expect(headRelativeStatus(merged[0])).toBe("modified");
  });

  it("leaves entries with distinct paths untouched", () => {
    const a: StatusEntry = { ...entry("M", "."), path: "a.ts" };
    const b: StatusEntry = { ...entry("A", "."), path: "b.ts" };
    expect(mergeDuplicatePaths([a, b])).toEqual([a, b]);
  });

  it("passes a lone entry through unchanged", () => {
    const solo = entry("M", ".");
    expect(mergeDuplicatePaths([solo])).toEqual([solo]);
  });
});

// F1: doPull's guard used to be `runSync(pullCmd(...), label)` — pullCmd(...)
// is an argument expression, so it (and the real `invoke("pull")` inside it)
// ran before runSync's `if (appState.syncing) return` ever executed. A
// double-click both await loadCurrentBranch()'s status() read (real time on a
// nested-submodule repo) before either reaches the guard, so the eager
// evaluation dispatched two real pulls, orphaning the second. doFetch has the
// same shape without even needing the async gap — it constructs fetchCmd(...)
// synchronously as runSync's argument. The fix makes runSync take a thunk, so
// the command is only constructed after the guard passes.
describe("doFetch / doPull re-entrancy", () => {
  beforeEach(() => {
    appState.repoPath = "";
    appState.repos = [];
    appState.changesRepoIdx = 0;
    appState.syncing = false;
    appState.error = null;
    appState.currentBranch = "main";
    appState.currentUpstream = "origin/main";
    appState.currentAhead = 0;
    appState.currentBehind = 0;
    appState.appMode = "changes";
    appState.refsRefresh = 0;
    appState.repoStatus = null;
    vi.mocked(fetchCmd).mockReset();
    vi.mocked(pullCmd).mockReset();
    vi.mocked(status).mockReset();
  });

  it("doFetch dispatches only one fetch when called twice back to back", () => {
    // Never resolves — doesn't matter, the assertion only needs the call count.
    vi.mocked(fetchCmd).mockReturnValue(new Promise<void>(() => {}));
    void doFetch();
    void doFetch();
    expect(fetchCmd).toHaveBeenCalledTimes(1);
  });

  it("doPull dispatches only one pull when a double-click races the pre-flight status read", async () => {
    // repoPath === "" makes the awaited loadCurrentBranch() inside doPull a
    // same-tick no-op (its own early-return guard), which is enough to
    // reproduce the race: both calls still cross an await point before
    // reaching runSync, exactly like the real awaited status() read does.
    vi.mocked(pullCmd).mockReturnValue(new Promise<void>(() => {}));
    void doPull(); // click A: reaches runSync first, dispatches the real pull
    await doPull(); // click B: same await gap, but loses the synchronous guard race
    expect(pullCmd).toHaveBeenCalledTimes(1);
  });
});

// F3: WorkingCopyList.svelte renders conflicts (always flat) first, then the
// rest deduped via mergeDuplicatePaths — workingCopyOrder feeds +page.svelte's
// ↑/↓ handler that same order so it never lands on a file that isn't visible.
describe("workingCopyOrder", () => {
  const conflict = (path: string): StatusEntry => ({
    path,
    orig_path: null,
    index_status: "U",
    worktree_status: "U",
  });
  const changed = (path: string): StatusEntry => ({
    path,
    orig_path: null,
    index_status: "M",
    worktree_status: ".",
  });

  it("puts conflicts first, ahead of the deduped changed list", () => {
    appState.repoStatus = {
      entries: [changed("b.ts"), conflict("a.ts")],
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
    };
    expect(workingCopyOrder().map((e) => e.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("dedupes the non-conflicted group the same way WorkingCopyList does", () => {
    appState.repoStatus = {
      // git rm --cached's split record for one path (see mergeDuplicatePaths).
      entries: [entry("D", "."), entry("?", "?")],
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
    };
    const order = workingCopyOrder();
    expect(order.length).toBe(1);
    expect(order[0].path).toBe("a.ts");
  });

  it("is empty when there's no status yet", () => {
    appState.repoStatus = null;
    expect(workingCopyOrder()).toEqual([]);
  });
});
