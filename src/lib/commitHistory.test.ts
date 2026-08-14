import { describe, expect, it, vi, beforeEach } from "vitest";

// commitHistory.ts imports the runes store, git.ts's Tauri wrappers, compare(),
// and workingCopy.ts (kept real — its mergeDuplicatePaths is exactly what
// loadWipCount is tested against here) at module load. Mock specifiers are
// resolved relative to THIS file, which shares src/lib with commitHistory.ts —
// mirrors workspace.test.ts's pattern.
vi.mock("./store.svelte", () => ({
  appState: { repoPath: "/repo", repos: [], historyRepoIdx: 0, wipCount: 0 },
}));
vi.mock("./git", () => ({
  status: vi.fn(),
  commitLog: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  opAbort: vi.fn(),
  opContinue: vi.fn(),
  pendingOp: vi.fn(),
}));
vi.mock("./compare", () => ({ compare: vi.fn() }));

import { loadWipCount } from "./commitHistory";
import { appState } from "./store.svelte";
import { status } from "./git";
import type { RepoStatus, StatusEntry } from "./types";

const entry = (
  path: string,
  index_status: string,
  worktree_status: string,
): StatusEntry => ({ path, orig_path: null, index_status, worktree_status });

const statusOf = (entries: StatusEntry[]): RepoStatus => ({
  entries,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
});

beforeEach(() => {
  appState.repoPath = "/repo";
  appState.repos = [];
  appState.historyRepoIdx = 0;
  appState.wipCount = 0;
  vi.mocked(status).mockReset();
});

// F4: wipCount used to be st.entries.length, which counts git rm --cached's
// two porcelain records for one path as two changes. Working Copy's own list
// already collapses that pair via mergeDuplicatePaths, so the graph's WIP node
// disagreed with the screen it links to. loadWipCount now routes through the
// same dedupe.
describe("loadWipCount", () => {
  it("dedupes git rm --cached's split record before counting", async () => {
    vi.mocked(status).mockResolvedValue(
      statusOf([entry("f.txt", "D", "."), entry("f.txt", "?", "?")]),
    );
    await loadWipCount();
    expect(appState.wipCount).toBe(1);
  });

  it("counts distinct paths normally", async () => {
    vi.mocked(status).mockResolvedValue(
      statusOf([entry("a.txt", "M", "."), entry("b.txt", "M", ".")]),
    );
    await loadWipCount();
    expect(appState.wipCount).toBe(2);
  });

  it("falls back to 0 when the status read fails", async () => {
    vi.mocked(status).mockRejectedValue(new Error("not a repo"));
    await loadWipCount();
    expect(appState.wipCount).toBe(0);
  });
});
