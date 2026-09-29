import { describe, it, expect } from "vitest";
import {
  allChangesText,
  commitStateText,
  groupCountsText,
  statusText,
  summaryText,
} from "./commitTableText";
import type { Commit } from "./types";

const names = { base: "main", compare: "feature/x" };
const merge: Commit = {
  sha: "3c9e2f1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  short_sha: "3c9e2f1",
  parents: ["b0", "f1"],
  author: "a",
  time: 0,
  summary: "Merge branch 'feature/x'",
  refs: [],
  body: "",
};

describe("summaryText", () => {
  it("counts what is not merged yet", () => {
    expect(summaryText({ kind: "unmerged", names, out: 8, patch: 1, behind: 9, repos: 1, failed: 0 })).toBe(
      "main ← feature/x: ● 8 not merged · ◐ 1 applied as patch · feature/x is 9 behind",
    );
    expect(summaryText({ kind: "unmerged", names, out: 140, patch: 1, behind: null, repos: 2, failed: 0 })).toBe(
      "main ← feature/x across 2 repos: ● 140 not merged · ◐ 1 applied as patch",
    );
    expect(summaryText({ kind: "unmerged", names, out: 3, patch: 0, behind: 0, repos: 1, failed: 0 })).toBe(
      "main ← feature/x: ● 3 not merged",
    );
  });

  it("says how many repos couldn't be read", () => {
    expect(summaryText({ kind: "unmerged", names, out: 3, patch: 0, behind: null, repos: 1, failed: 1 })).toBe(
      "main ← feature/x: ● 3 not merged · 1 repo couldn't be read",
    );
    expect(summaryText({ kind: "unmerged", names, out: 140, patch: 1, behind: null, repos: 2, failed: 2 })).toBe(
      "main ← feature/x across 2 repos: ● 140 not merged · ◐ 1 applied as patch · 2 repos couldn't be read",
    );
    expect(summaryText({ kind: "all-in", names, repos: 1, failed: 1 })).toBe(
      "✓ All changes on feature/x are in main across 1 repo · 1 repo couldn't be read",
    );
    expect(summaryText({ kind: "all-in", names, repos: 3, failed: 2 })).toBe(
      "✓ All changes on feature/x are in main across 3 repos · 2 repos couldn't be read",
    );
  });

  it("says when only patches are left", () => {
    expect(summaryText({ kind: "patches", names, patch: 2 })).toBe(
      "✓ Every commit on feature/x is in main, 2 of them as patches (rebased, cherry-picked or squash-merged)",
    );
    expect(summaryText({ kind: "patches", names, patch: 1 })).toBe(
      "✓ Every commit on feature/x is in main, 1 of them as a patch (rebased, cherry-picked or squash-merged)",
    );
  });

  it("names the merge that brought everything in", () => {
    expect(summaryText({ kind: "merged", names, mergedBy: merge })).toMatch(
      /^✓ All commits on feature\/x are in main — merged by 3c9e2f1 "Merge branch 'feature\/x'" · /,
    );
    expect(summaryText({ kind: "merged", names, mergedBy: null })).toBe(
      "✓ All commits on feature/x are in main (fast-forward, no merge commit)",
    );
  });

  it("does not call an unknown merge a fast-forward", () => {
    // The introducing-merge lookup can fail; that only drops "merged by".
    expect(summaryText({ kind: "merged", names, mergedBy: undefined })).toBe(
      "✓ All commits on feature/x are in main",
    );
  });

  it("covers the remaining states", () => {
    expect(summaryText({ kind: "all-in", names, repos: 2, failed: 0 })).toBe(
      "✓ All changes on feature/x are in main across 2 repos",
    );
    expect(summaryText({ kind: "no-refs" })).toBe(
      "Pick base and compare to see which commits are merged.",
    );
    expect(summaryText({ kind: "same" })).toBe("base and compare are the same.");
    expect(summaryText({ kind: "loading" })).toBe("Checking commits…");
    expect(summaryText({ kind: "error" })).toBe("Couldn't read commits.");
  });
});

describe("group, row and Files header text", () => {
  it("writes a group header's counts", () => {
    expect(groupCountsText({ out: 3, patch: 1, behind: 9 }, names, { mergedBy: undefined })).toBe(
      "● 3 ◐ 1 · feature/x is 9 behind",
    );
    expect(groupCountsText({ out: 0, patch: 0, behind: 0 }, names, { mergedBy: merge })).toBe(
      "✓ all in main · merged by 3c9e2f1",
    );
    expect(groupCountsText({ out: 0, patch: 0, behind: 0 }, names, { mergedBy: null })).toBe(
      "✓ all in main",
    );
  });

  it("writes a row's status", () => {
    expect(statusText("out", names)).toBe("not in main");
    expect(statusText("patch", names)).toBe("applied as patch");
    expect(statusText("in", names)).toBe("in main");
  });

  it("writes the picked commit's state", () => {
    expect(commitStateText("out", names, null)).toBe("not in main");
    expect(commitStateText("patch", names, null)).toBe("applied to main as a patch");
    expect(commitStateText("in", names, { in_target: true, introduced_by: merge })).toMatch(
      /^merged by 3c9e2f1 \(/,
    );
    expect(commitStateText("in", names, null)).toBe("in main");
  });

  it("writes the all-changes line", () => {
    expect(allChangesText(names)).toBe("All changes · main ← feature/x");
  });
});
