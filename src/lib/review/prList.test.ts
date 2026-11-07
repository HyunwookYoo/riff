import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gh", () => ({ ghStatus: vi.fn(), gitRemotes: vi.fn() }));
vi.mock("./github", () => ({ viewerLogin: vi.fn(), searchPrs: vi.fn() }));

import { ghStatus } from "./gh";
import { searchPrs, viewerLogin } from "./github";
import {
  collectRepos,
  headMoveFor,
  keysToDelete,
  listedHeadMove,
  loadPrList,
  loginHint,
  REFRESH_MS,
  type HostState,
} from "./prList";
import { emptyRecord } from "./draft";

const remotes = (m: Record<string, { name: string; url: string }[]>) => async (p: string) => m[p] ?? [];

beforeEach(() => vi.resetAllMocks());

describe("collectRepos", () => {
  it("groups by host and prefers origin", async () => {
    const out = await collectRepos(
      [{ path: "a" }, { path: "b" }],
      remotes({
        a: [
          { name: "up", url: "git@ghe.corp:o/up.git" },
          { name: "origin", url: "https://github.com/o/a.git" },
        ],
        b: [{ name: "fork", url: "https://github.com/o/b.git" }],
      }),
    );
    expect([...out.keys()].sort()).toEqual(["github.com"]);
    expect(out.get("github.com")).toEqual([
      { repo: { host: "github.com", owner: "o", name: "a" }, repoIdx: 0, remote: "origin" },
      { repo: { host: "github.com", owner: "o", name: "b" }, repoIdx: 1, remote: "fork" },
    ]);
  });

  it("skips non-GitHub remotes", async () => {
    const out = await collectRepos(
      [{ path: "a" }, { path: "b" }],
      remotes({ a: [{ name: "origin", url: "/local/path" }], b: [] }),
    );
    expect(out.size).toBe(0);
  });
});

describe("loadPrList", () => {
  it("keeps other hosts when one host is logged out", async () => {
    vi.mocked(ghStatus).mockImplementation(async (h) => (h === "ghe.corp" ? "notloggedin" : "ready"));
    vi.mocked(viewerLogin).mockResolvedValue("me");
    vi.mocked(searchPrs).mockResolvedValue([{ key: "github.com/o/a#1" } as never]);
    const r = await loadPrList(
      [{ path: "a" }, { path: "b" }],
      remotes({
        a: [{ name: "origin", url: "https://github.com/o/a.git" }],
        b: [{ name: "origin", url: "git@ghe.corp:o/b.git" }],
      }),
    );
    expect(r.prs).toHaveLength(1);
    const bad = r.hosts.find((h) => h.host === "ghe.corp")!;
    expect(bad.status).toBe("notloggedin");
    expect(bad.message).toContain(loginHint("ghe.corp"));
    expect(r.hosts.find((h) => h.host === "github.com")!.status).toBe("ready");
  });
});

it("loginHint text", () => {
  expect(loginHint("h.com")).toBe("gh auth login --hostname h.com");
  expect(REFRESH_MS).toBe(300_000);
});

describe("headMoveFor", () => {
  it("reopen after re-anchor still reports the head move", () => {
    const r = { ...emptyRecord("k"), anchorHead: "H2", viewedHead: "H1" };
    expect(headMoveFor(r, "H2")).toEqual({ from: "H1", to: "H2" });
  });
  it("is null when seen or never viewed", () => {
    expect(headMoveFor({ ...emptyRecord("k"), viewedHead: "H2" }, "H2")).toBeNull();
    expect(headMoveFor(emptyRecord("k"), "H2")).toBeNull();
  });
});

describe("listedHeadMove", () => {
  const prs = [{ key: "k", headSha: "H2" }, { key: "other", headSha: "X" }];
  it("flags the selected PR's listed head moving past the displayed one", () => {
    expect(listedHeadMove(prs, "k", "H1", null)).toEqual({ from: "H1", to: "H2" });
    // A viewedHead move already shown is replaced by the newer push.
    expect(listedHeadMove(prs, "k", "H1", { from: "H0", to: "H1" })).toEqual({ from: "H1", to: "H2" });
  });
  it("is null when nothing changes", () => {
    expect(listedHeadMove(prs, "k", "H2", null)).toBeNull(); // same head
    expect(listedHeadMove(prs, "k", "H1", { from: "H1", to: "H2" })).toBeNull(); // already set to that
    expect(listedHeadMove(prs, "gone", "H1", null)).toBeNull(); // not listed
    expect(listedHeadMove(prs, null, "H1", null)).toBeNull(); // nothing selected
    expect(listedHeadMove(prs, "k", null, null)).toBeNull(); // still loading
  });
});

describe("keysToDelete", () => {
  const ready: HostState[] = [{ host: "github.com", status: "ready", message: null }];
  const rec = (key: string, body = "", items = 0) =>
    ({ ...emptyRecord(key), body, items: Array(items).fill({}) }) as never;
  it("deletes empty unlisted record of a ready host", () => {
    const k = "github.com/o/a#1";
    expect(keysToDelete([k], new Map([[k, rec(k)]]), new Set(), ready)).toEqual([k]);
  });
  it("keeps body-only drafts, items, listed keys and unreadable records", () => {
    const a = "github.com/o/a#1", b = "github.com/o/a#2", c = "github.com/o/a#3", d = "github.com/o/a#4";
    const m = new Map([[a, rec(a, " hi ")], [b, rec(b, "", 1)], [c, rec(c)], [d, null]]);
    expect(keysToDelete([a, b, c, d], m, new Set([c]), ready)).toEqual([]);
  });
  it("keeps records of a host that is not ready", () => {
    const k = "ghe.corp/o/a#1";
    const hosts: HostState[] = [...ready, { host: "ghe.corp", status: "notloggedin", message: "x" }];
    expect(keysToDelete([k], new Map([[k, rec(k)]]), new Set(), hosts)).toEqual([]);
    expect(keysToDelete([k], new Map([[k, rec(k)]]), new Set(), [])).toEqual([]);
  });
});
