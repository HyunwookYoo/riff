import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gh", () => ({ ghStatus: vi.fn(), gitRemotes: vi.fn() }));
vi.mock("./github", () => ({ viewerLogin: vi.fn(), searchPrs: vi.fn() }));

import { ghStatus } from "./gh";
import { searchPrs, viewerLogin } from "./github";
import { collectRepos, loadPrList, loginHint, REFRESH_MS } from "./prList";

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
