import { describe, expect, it } from "vitest";
import {
  applyFilter,
  authorOptions,
  DEFAULT_FILTER,
  filterActive,
  highlight,
  isNumberQuery,
  matchQuery,
  normalizeFilter,
  repoOptions,
  type PrFilter,
} from "./prFilter";
import type { PrSummary } from "./types";

const pr = (number: number, o: Partial<PrSummary> = {}): PrSummary => ({
  key: `github.com/o/a#${number}`, repo: { host: "github.com", owner: "o", name: "a" }, repoIdx: 0,
  remote: "origin", nodeId: `N${number}`, number, title: `t${number}`, author: "alice", url: "",
  additions: 0, deletions: 0, headSha: "h", baseSha: "b", baseRef: "main",
  updatedAt: `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
  mine: null, myLastReviewSha: null, viewer: "me", ...o,
});
const f = (o: Partial<PrFilter> = {}): PrFilter => ({ ...DEFAULT_FILTER, ...o });
const nums = (prs: PrSummary[]) => prs.map((p) => p.number);

describe("matchQuery", () => {
  const p = pr(1765, { title: "Fix Humanoid TouchEnded" });
  it("empty or blank matches everything", () => {
    expect(matchQuery(p, "")).toBe(true);
    expect(matchQuery(p, "   ")).toBe(true);
  });
  it("digits, with or without #, match a number prefix", () => {
    expect(matchQuery(p, "17")).toBe(true);
    expect(matchQuery(p, "#1765")).toBe(true);
    expect(matchQuery(p, " #176 ")).toBe(true);
    expect(matchQuery(p, "765")).toBe(false);
    expect(matchQuery(p, "#17650")).toBe(false);
  });
  it("other text is a case-insensitive title substring", () => {
    expect(matchQuery(p, "humanoid touch")).toBe(true);
    expect(matchQuery(p, "TOUCHENDED")).toBe(true);
    expect(matchQuery(p, "touched")).toBe(false);
    // A digit query never searches titles; a mixed one does.
    expect(matchQuery(pr(1, { title: "Bump to 2026" }), "2026")).toBe(false);
    expect(matchQuery(pr(1, { title: "Bump to 2026" }), "to 2026")).toBe(true);
  });
  it("regex characters are literal", () => {
    expect(matchQuery(pr(1, { title: "[OVDR-1] a.b (c)" }), "[ovdr-1]")).toBe(true);
    expect(matchQuery(pr(1, { title: "axb" }), "a.b")).toBe(false);
  });
});

describe("isNumberQuery", () => {
  it("is digits with an optional leading #", () => {
    expect(isNumberQuery("#12")).toBe(true);
    expect(isNumberQuery(" 12 ")).toBe(true);
    expect(isNumberQuery("#")).toBe(false);
    expect(isNumberQuery("1 2")).toBe(false);
    expect(isNumberQuery("")).toBe(false);
  });
});

describe("applyFilter", () => {
  const prs = [
    pr(1, { mine: "reviewed", author: "bob" }),
    pr(5, { mine: "requested", author: "alice", title: "Touch fix" }),
    pr(3, { author: "me", title: "touch more" }),
    pr(4, { mine: "requested", author: "bob", repo: { host: "github.com", owner: "o", name: "b" }, key: "github.com/o/b#4" }),
    pr(2, { mine: "reviewed", author: "alice" }),
  ];

  it("All lists everything by updatedAt desc", () => {
    const r = applyFilter(prs, f(), "");
    expect(nums(r.list)).toEqual([5, 4, 3, 2, 1]);
    expect(r.sections).toBeNull();
    expect(r.counts).toEqual({ all: 5, mine: 4 });
    expect(r.total).toBe(5);
  });

  it("For me lists requested then reviewed, each by updatedAt desc", () => {
    const r = applyFilter(prs, f({ show: "mine" }), "");
    expect(nums(r.list)).toEqual([5, 4, 2, 1]);
    expect(nums(r.sections!.requested)).toEqual([5, 4]);
    expect(nums(r.sections!.reviewed)).toEqual([2, 1]);
    expect(r.counts).toEqual({ all: 5, mine: 4 });
  });

  it("filters by author, with @me meaning the viewer", () => {
    expect(nums(applyFilter(prs, f({ author: "bob" }), "").list)).toEqual([4, 1]);
    expect(nums(applyFilter(prs, f({ author: "@me" }), "").list)).toEqual([3]);
    // Another host's viewer is that host's login.
    const other = pr(9, { author: "me2", viewer: "me2" });
    expect(nums(applyFilter([...prs, other], f({ author: "@me" }), "").list)).toEqual([9, 3]);
  });

  it("filters by repo key", () => {
    expect(nums(applyFilter(prs, f({ repo: "github.com/o/b" }), "").list)).toEqual([4]);
    // The key is lowercased; the listed repo may not be.
    const upper = pr(8, { repo: { host: "github.com", owner: "O", name: "B" } });
    expect(nums(applyFilter([upper], f({ repo: "github.com/o/b" }), "").list)).toEqual([8]);
  });

  it("a filter on something no longer listed keeps filtering", () => {
    const r = applyFilter(prs, f({ author: "gone", repo: "github.com/o/gone" }), "");
    expect(r.list).toEqual([]);
    expect(r.counts).toEqual({ all: 0, mine: 0 });
    expect(r.total).toBe(5);
  });

  it("combines filters and the query; counts ignore show only", () => {
    const r = applyFilter(prs, f({ show: "mine", author: "alice" }), "touch");
    expect(nums(r.list)).toEqual([5]);
    expect(r.counts).toEqual({ all: 1, mine: 1 });
    const all = applyFilter(prs, f({ author: "alice" }), "");
    expect(nums(all.list)).toEqual([5, 2]);
    expect(applyFilter(prs, f(), "touch").counts).toEqual({ all: 2, mine: 1 });
    expect(nums(applyFilter(prs, f(), "#4").list)).toEqual([4]);
  });

  it("does not reorder its input", () => {
    const input = [...prs];
    applyFilter(input, f(), "");
    expect(nums(input)).toEqual([1, 5, 3, 4, 2]);
  });
});

describe("filterActive", () => {
  it("is set by any filter or a non-blank query", () => {
    expect(filterActive(f(), "")).toBe(false);
    expect(filterActive(f(), "  ")).toBe(false);
    expect(filterActive(f({ show: "mine" }), "")).toBe(true);
    expect(filterActive(f({ author: "x" }), "")).toBe(true);
    expect(filterActive(f({ repo: "h/o/n" }), "")).toBe(true);
    expect(filterActive(f(), "x")).toBe(true);
  });
});

describe("authorOptions", () => {
  const prs = [
    pr(1, { author: "bob" }), pr(2, { author: "carol" }), pr(3, { author: "bob" }),
    pr(4, { author: "me" }), pr(5, { author: "abe" }), pr(6, { author: "carol" }),
  ];
  it("lists other authors by count desc then name, and counts mine", () => {
    expect(authorOptions(prs, null)).toEqual({
      meCount: 1,
      authors: [{ login: "bob", count: 2 }, { login: "carol", count: 2 }, { login: "abe", count: 1 }],
    });
  });
  it("keeps a selected author that is no longer listed, at 0", () => {
    expect(authorOptions(prs, "gone").authors.at(-1)).toEqual({ login: "gone", count: 0 });
    expect(authorOptions(prs, "bob").authors).toHaveLength(3);
    expect(authorOptions(prs, "@me").authors).toHaveLength(3);
    expect(authorOptions([], null)).toEqual({ meCount: 0, authors: [] });
  });
});

describe("repoOptions", () => {
  const a = { host: "github.com", owner: "o", name: "a" };
  const b = { host: "ghe.corp", owner: "Team", name: "Big" };
  it("lists repos with counts by name; the filter shows from two", () => {
    expect(repoOptions([pr(1, { repo: a }), pr(2, { repo: b }), pr(3, { repo: b })], null)).toEqual({
      repos: [
        { key: "github.com/o/a", label: "o/a", count: 1 },
        { key: "ghe.corp/team/big", label: "Team/Big", count: 2 },
      ],
      showRepoFilter: true,
    });
    expect(repoOptions([pr(1, { repo: a }), pr(2, { repo: a })], null).showRepoFilter).toBe(false);
  });
  it("keeps a selected repo that is no longer listed, at 0, so it can be cleared", () => {
    const r = repoOptions([pr(1, { repo: a })], "github.com/x/gone");
    expect(r.repos).toEqual([
      { key: "github.com/o/a", label: "o/a", count: 1 },
      { key: "github.com/x/gone", label: "x/gone", count: 0 },
    ]);
    expect(r.showRepoFilter).toBe(true);
  });
});

describe("highlight", () => {
  it("marks every case-insensitive match", () => {
    expect(highlight("Touch the touchpad", "TOUCH")).toEqual([
      { text: "Touch", hit: true }, { text: " the ", hit: false }, { text: "touch", hit: true },
      { text: "pad", hit: false },
    ]);
  });
  it("is the whole title unmarked for no query, a number query or no match", () => {
    const whole = [{ text: "Fix 12", hit: false }];
    expect(highlight("Fix 12", "")).toEqual(whole);
    expect(highlight("Fix 12", "#12")).toEqual(whole);
    expect(highlight("Fix 12", "zzz")).toEqual(whole);
  });
  it("treats regex characters literally and trims the query", () => {
    expect(highlight("[A] b", " [a] ")).toEqual([{ text: "[A]", hit: true }, { text: " b", hit: false }]);
  });
});

describe("normalizeFilter", () => {
  it("keeps a valid stored filter", () => {
    expect(normalizeFilter({ show: "mine", author: "bob", repo: "github.com/o/a" })).toEqual({
      show: "mine", author: "bob", repo: "github.com/o/a",
    });
  });
  it("falls back to defaults per field", () => {
    expect(normalizeFilter(undefined)).toEqual(DEFAULT_FILTER);
    expect(normalizeFilter(null)).toEqual(DEFAULT_FILTER);
    expect(normalizeFilter("x")).toEqual(DEFAULT_FILTER);
    expect(normalizeFilter({ show: "everything", author: 3, repo: "" })).toEqual(DEFAULT_FILTER);
    expect(normalizeFilter({ show: "all", author: null, repo: "h/o/n" })).toEqual(f({ repo: "h/o/n" }));
  });
  it("returns a fresh object", () => {
    expect(normalizeFilter(null)).not.toBe(DEFAULT_FILTER);
  });
});
