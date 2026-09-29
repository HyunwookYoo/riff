import { describe, it, expect } from "vitest";
import {
  allChangesText,
  commitStateText,
  groupCountsText,
  noGroupSummaryText,
  statusText,
  summaryText,
} from "./commitTableText";
import type { Commit, SquashCheck } from "./types";

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

describe("the summary with no group on screen", () => {
  const pair = { base: "main", compare: "feature/x" };
  const pickRefs = "Pick base and compare to see which commits are merged.";

  it("asks for refs while the toolbar pair misses a side", () => {
    expect(noGroupSummaryText({ base: "main", compare: "" }, { ok: false, reason: "no-refs" }, "sandbox")).toBe(
      pickRefs,
    );
    expect(noGroupSummaryText({ base: "", compare: "" }, undefined, "sandbox")).toBe(pickRefs);
  });

  it("says why the visible repo has no range once both refs are picked", () => {
    // Review focus (F5): a submodule tab or Focus on an unmoved pin must not
    // be told to pick refs that are already picked.
    const unchanged = { ok: false as const, reason: "unchanged" as const, pin: "1a2b3c4d5e6f7a8b" };
    expect(noGroupSummaryText(pair, unchanged, "sandbox")).toBe("unchanged: both pin 1a2b3c4");
    expect(noGroupSummaryText(pair, { ok: false, reason: "added", pin: "b93f7d2" }, "sandbox")).toBe(
      "only in feature/x (added)",
    );
    expect(noGroupSummaryText(pair, { ok: false, reason: "no-refs" }, "sandbox")).toBe("pick both refs");
  });

  it("waits for the group of a range that resolved", () => {
    const own = { ok: true as const, path: "/sub", base: "develop", compare: "feature/y", source: "override" as const };
    expect(noGroupSummaryText(pair, own, "sandbox")).toBe("Checking commits…");
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
    expect(commitStateText("in", names, { in_target: true, introduced_by: null })).toBe("in main");
  });

  it("claims a listed commit is in base only once its detail says so", () => {
    // Review focus (F3): a row outside the ● / ◐ sets is not proof of "in".
    expect(commitStateText("in", names, { in_target: false, introduced_by: null })).toBe(
      "not in main",
    );
    expect(commitStateText("in", names, null)).toBeNull();
  });

  it("writes the all-changes line", () => {
    expect(allChangesText(names)).toBe("All changes · main ← feature/x");
  });
});

const squashed: SquashCheck = {
  verdict: "squash",
  squash_commit: { ...merge, sha: "7f3a2c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", short_sha: "7f3a2c1", parents: ["x"], summary: "Add MCP import (#1677)" },
};
const content: SquashCheck = { verdict: "content", squash_commit: null };

describe("squash wording", () => {
  it("summarizes a squash, a content match and no net change", () => {
    expect(summaryText({ kind: "squash", names, commit: squashed.squash_commit! })).toMatch(
      /^✓ All changes on feature\/x are in main — squash-merged as 7f3a2c1 "Add MCP import \(#1677\)" · /,
    );
    expect(summaryText({ kind: "content", names })).toBe(
      "✓ All changes on feature/x are already in main (content matches; no single squash commit found)",
    );
    expect(summaryText({ kind: "no-net-change", names })).toBe(
      "feature/x makes no net change against main",
    );
  });

  it("marks a squashed group's header", () => {
    expect(groupCountsText({ out: 0, patch: 3, behind: 0 }, names, { mergedBy: undefined, landed: squashed })).toBe(
      "◐ 3 · squash-merged as 7f3a2c1",
    );
    expect(groupCountsText({ out: 0, patch: 3, behind: 0 }, names, { mergedBy: undefined, landed: content })).toBe(
      "◐ 3 · content already in main",
    );
    expect(groupCountsText({ out: 5, patch: 0, behind: 0 }, names, { mergedBy: undefined, checking: true })).toBe(
      "● 5 · checking for squash…",
    );
  });

  it("names how a squashed row and a picked squashed commit got in", () => {
    expect(statusText("squash", names, squashed)).toBe("squashed into 7f3a2c1");
    expect(statusText("squash", names, content)).toBe("changes already in main");
    expect(commitStateText("squash", names, null, squashed)).toMatch(/^squashed into main as 7f3a2c1 \(/);
    expect(commitStateText("squash", names, null, content)).toBe("its changes are already in main");
  });

  it("says all changes already landed", () => {
    expect(allChangesText(names, squashed)).toBe(
      "All changes · main ← feature/x — already in main (squash-merged as 7f3a2c1)",
    );
    expect(allChangesText(names, content)).toBe("All changes · main ← feature/x — already in main");
  });
});
