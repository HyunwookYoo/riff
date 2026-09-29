import { describe, it, expect } from "vitest";
import {
  diffModeLabel,
  diffModeName,
  diffRangeText,
  pairLabel,
  paneLabels,
  rangeLabel,
  rangeTooltip,
  scopeText,
  shortRef,
  sideNames,
} from "./rangeText";
import type { RepoRange } from "./types";

const SHA_A = "5e1c0aa7b2c3d4e5f60718293a4b5c6d7e8f9012";
const SHA_B = "b93f7d2c1d2e3f405162738495a6b7c8d9e0f123";
const pair = { base: "main", compare: "feature/x" };
const toolbar: RepoRange = { ok: true, path: "/m", base: "main", compare: "feature/x", source: "toolbar" };
const gitlink: RepoRange = { ok: true, path: "/s", base: SHA_A, compare: SHA_B, source: "gitlink" };
const override: RepoRange = { ok: true, path: "/s", base: "develop", compare: "feature/y", source: "override" };
const sameName: RepoRange = { ok: true, path: "/l", base: "main", compare: "feature/x", source: "same-name" };

describe("shortRef", () => {
  it("shortens a full SHA and leaves names alone", () => {
    expect(shortRef(SHA_A)).toBe("5e1c0aa");
    expect(shortRef("feature/x")).toBe("feature/x");
  });

  it("keeps a revision suffix after shortening", () => {
    // Drill-in writes `<sha>^`; the label must stay short and keep the caret.
    expect(shortRef(`${SHA_A}^`)).toBe("5e1c0aa^");
    expect(shortRef(`${SHA_A}~2`)).toBe("5e1c0aa~2");
  });
});

describe("pairLabel / sideNames", () => {
  it("writes base ← compare", () => {
    expect(pairLabel("main", SHA_B)).toBe("main ← b93f7d2");
  });

  it("names a gitlink range's sides after the refs that pin them", () => {
    if (!gitlink.ok) throw new Error("fixture");
    expect(sideNames(gitlink, pair)).toEqual({ base: "main's pin", compare: "feature/x's pin" });
  });

  it("names other ranges by their refs", () => {
    if (!override.ok) throw new Error("fixture");
    expect(sideNames(override, pair)).toEqual({ base: "develop", compare: "feature/y" });
  });
});

describe("rangeLabel", () => {
  it("labels each source", () => {
    expect(rangeLabel(toolbar, "sandbox", pair)).toBe("main ← feature/x");
    expect(rangeLabel(gitlink, "sandbox", pair)).toBe("pinned by sandbox: 5e1c0aa ← b93f7d2");
    expect(rangeLabel(override, "sandbox", pair)).toBe("own branches: develop ← feature/y");
    expect(rangeLabel(sameName, "sandbox", pair)).toBe("same names: main ← feature/x");
  });

  it("labels each gap", () => {
    const gap = (reason: string, extra: object = {}) =>
      rangeLabel({ ok: false, reason, ...extra } as RepoRange, "sandbox", pair);
    expect(gap("no-refs")).toBe("pick both refs");
    expect(gap("unchanged", { pin: SHA_A })).toBe("unchanged: both pin 5e1c0aa");
    expect(gap("added", { pin: SHA_B })).toBe("only in feature/x (added)");
    expect(gap("removed", { pin: SHA_A })).toBe("not in feature/x (removed)");
    expect(gap("absent")).toBe("not in main or feature/x");
    expect(gap("error", { message: "boom" })).toBe("couldn't resolve: boom");
  });
});

describe("rangeTooltip / scopeText", () => {
  it("explains which ref pins which commit", () => {
    expect(rangeTooltip(gitlink, pair)).toBe("main pins 5e1c0aa · feature/x pins b93f7d2");
    expect(rangeTooltip(toolbar, pair)).toBeUndefined();
  });

  it("says what a focused repo follows", () => {
    expect(scopeText(gitlink, "sandbox", pair)).toBe(
      "following sandbox: main pins 5e1c0aa ← feature/x pins b93f7d2",
    );
    expect(scopeText(sameName, "sandbox", pair)).toBe(
      "same branch names as sandbox: main ← feature/x",
    );
    expect(scopeText({ ok: false, reason: "unchanged", pin: SHA_A }, "sandbox", pair)).toBe(
      "unchanged: both pin 5e1c0aa",
    );
  });
});

describe("diff mode and diff header", () => {
  it("names the diff modes", () => {
    expect(diffModeLabel("three-dot")).toBe("since fork (...)");
    expect(diffModeLabel("two-dot")).toBe("direct (..)");
    expect(diffModeName("three-dot")).toBe("since fork");
    expect(diffModeName("two-dot")).toBe("direct");
  });

  it("shows the drilled commit, else the range, else nothing", () => {
    expect(diffRangeText(toolbar, SHA_A)).toBe("commit 5e1c0aa");
    expect(diffRangeText(gitlink, null)).toBe("5e1c0aa ← b93f7d2");
    expect(diffRangeText({ ok: false, reason: "no-refs" }, null)).toBeNull();
    expect(diffRangeText(undefined, null)).toBeNull();
  });
});

describe("paneLabels", () => {
  it("labels a three-dot and a two-dot range", () => {
    expect(paneLabels(toolbar, pair, "three-dot", null)).toEqual({
      left: "base · main (merge-base)",
      right: "compare · feature/x",
    });
    expect(paneLabels(toolbar, pair, "two-dot", null)).toEqual({
      left: "base · main",
      right: "compare · feature/x",
    });
  });

  it("labels a gitlink range by the pins", () => {
    expect(paneLabels(gitlink, pair, "three-dot", null)).toEqual({
      left: "base · 5e1c0aa (main's pin)",
      right: "compare · b93f7d2 (feature/x's pin)",
    });
  });

  it("labels a picked commit as parent and commit", () => {
    expect(paneLabels(toolbar, pair, "three-dot", { target: SHA_A, summary: "Add clone" })).toEqual({
      left: "5e1c0aa^ (parent)",
      right: "5e1c0aa · Add clone",
    });
  });

  it("has nothing to say without a range", () => {
    expect(paneLabels({ ok: false, reason: "no-refs" }, pair, "three-dot", null)).toBeNull();
  });
});
