import { describe, it, expect, beforeEach, vi } from "vitest";

// tabs.ts drives the runes store, compare(), the pick-dropping helper and the
// active diff view; all are stubbed. Specifiers resolve relative to this file
// (src/lib).
vi.mock("./store.svelte", () => ({ appState: {} }));
vi.mock("./compare", () => ({ compare: vi.fn() }));
vi.mock("./branchContainment", () => ({ dropPickOutside: vi.fn() }));
vi.mock("./diff/activeView", () => ({ getActiveDiffView: vi.fn() }));

import { selectTab } from "./tabs";
import { appState } from "./store.svelte";
import { compare } from "./compare";
import { dropPickOutside } from "./branchContainment";
import type { ChangedFile, RepoEntry } from "./types";

const repos: RepoEntry[] = [
  { path: "/main", kind: "main", displayName: "main" },
  { path: "/main/sub", kind: "submodule", displayName: "sub", parentGitlinkPath: "sub" },
];
const file = (path: string, repoIdx: number): ChangedFile => ({
  path,
  old_path: null,
  status: "modified",
  repoIdx,
});
// Tabs scans every repo, so the super repo's file streams in first.
const listed = [file("m.txt", 0), file("a.txt", 1), file("b.txt", 1)];
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.mocked(compare).mockReset();
  vi.mocked(dropPickOutside).mockReset();
  Object.assign(appState, {
    repos,
    activeRepoIdx: 0,
    selectedFile: null,
    files: [],
    tabMemory: new Map(),
  });
});

describe("selectTab", () => {
  it("restores the tab's remembered file", () => {
    appState.files = listed;
    appState.tabMemory = new Map([[1, { filePath: "b.txt" }]]);
    selectTab(1);
    expect(appState.selectedFile?.path).toBe("b.txt");
    expect(compare).not.toHaveBeenCalled();
  });

  it("falls back to the tab's first file", () => {
    appState.files = listed;
    selectTab(1);
    expect(appState.selectedFile?.path).toBe("a.txt");
  });

  describe("when a picked commit belongs to another repo", () => {
    // Review focus: compare() selects the first file it streams, which in Tabs
    // is repo 0's; the new tab must end up on its own file, not that one.
    beforeEach(() => {
      vi.mocked(dropPickOutside).mockReturnValue(true);
      vi.mocked(compare).mockImplementation(async () => {
        appState.files = listed;
        appState.selectedFile = listed[0];
      });
    });

    it("re-lists, then selects the tab's remembered file", async () => {
      appState.tabMemory = new Map([[1, { filePath: "b.txt" }]]);
      selectTab(1);
      expect(dropPickOutside).toHaveBeenCalledWith(1);
      expect(compare).toHaveBeenCalledWith({ silent: true });
      await tick();
      expect(appState.selectedFile?.path).toBe("b.txt");
    });

    it("re-lists, then selects the tab's first file", async () => {
      selectTab(1);
      await tick();
      expect(appState.selectedFile?.path).toBe("a.txt");
    });

    it("leaves the selection alone when the user moved on before the list landed", async () => {
      let land: () => void = () => {};
      vi.mocked(compare).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            land = () => {
              appState.files = listed;
              appState.selectedFile = listed[0];
              resolve();
            };
          }),
      );
      selectTab(1);
      appState.activeRepoIdx = 0;
      land();
      await tick();
      expect(appState.selectedFile?.path).toBe("m.txt");
    });
  });
});
