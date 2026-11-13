import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gh", () => ({ ghGraphql: vi.fn() }));

import { ghGraphql } from "./gh";
import { addThread, openPrs, prDetail, searchPrs } from "./github";

const gql = vi.mocked(ghGraphql);

function node(id: string, number: number, repo = "Octo/Repo", reviewSha: string | null = null) {
  return {
    id, number, title: `t${number}`, author: { login: "alice" }, url: `https://h/${repo}/pull/${number}`,
    additions: 3, deletions: 1, headRefOid: "h" + number, baseRefOid: "b" + number, baseRefName: "main",
    updatedAt: "2026-01-01T00:00:00Z", repository: { nameWithOwner: repo },
    reviews: { nodes: reviewSha ? [{ commit: { oid: reviewSha } }] : [] },
  };
}

// A block body: a returned mock would run as a cleanup hook, with no arguments.
beforeEach(() => {
  gql.mockReset();
});

type Node = ReturnType<typeof node>;
type Page = { nodes: Node[]; more?: boolean };

/**
 * Fakes GitHub: the two `@me` searches return `requested` / `reviewed`; the open-PR
 * query pages through `open["owner/name"]` (cursor `c<next page>`). `more` claims a
 * next page that the fake doesn't have. `fail` repos' open-PR query throws. The
 * by-number query answers from `byNumber["owner/name#N"]` (an Error is thrown).
 */
function serve(o: {
  requested?: Node[]; reviewed?: Node[]; open?: Record<string, Page[]>; archived?: string[]; fail?: string[];
  byNumber?: Record<string, { state: string; node: Node } | Error>;
}) {
  gql.mockImplementation(async (_host, query, vars) => {
    if (query.includes("search(")) {
      return { search: { nodes: String(vars.q).includes("review-requested") ? o.requested ?? [] : o.reviewed ?? [] } } as never;
    }
    const name = `${vars.owner}/${vars.name}`;
    if (query.includes("pullRequest(number")) {
      const hit = o.byNumber?.[`${name}#${vars.number}`];
      if (hit instanceof Error) throw hit;
      if (!hit) throw new Error(`no PR ${name}#${vars.number}`);
      return {
        repository: { isArchived: o.archived?.includes(name) ?? false, pullRequest: { state: hit.state, ...hit.node } },
      } as never;
    }
    if (o.fail?.includes(name)) throw new Error(`boom ${name}`);
    const pages = o.open?.[name] ?? [{ nodes: [] }];
    const i = vars.after == null ? 0 : Number(String(vars.after).slice(1));
    return {
      repository: {
        isArchived: o.archived?.includes(name) ?? false,
        pullRequests: {
          pageInfo: { hasNextPage: i + 1 < pages.length || !!pages[i].more, endCursor: `c${i + 1}` },
          nodes: pages[i].nodes,
        },
      },
    } as never;
  });
}

const openCalls = () => gql.mock.calls.filter((c) => String(c[1]).includes("pullRequests("));
const numberCalls = () => gql.mock.calls.filter((c) => String(c[1]).includes("pullRequest(number"));
const listed = async (repos: Parameters<typeof searchPrs>[1], wanted: string[] = []) =>
  (await searchPrs("h", repos, "me", wanted)).prs;

describe("searchPrs", () => {
  const repos = [
    { repo: { host: "h", owner: "octo", name: "repo" }, repoIdx: 2, remote: "origin" },
    { repo: { host: "h", owner: "octo", name: "sub" }, repoIdx: 5, remote: "up" },
  ];

  it("lists every open PR, marks the viewer's (requested wins) and sets viewer", async () => {
    serve({
      requested: [node("N1", 1)],
      reviewed: [node("N1", 1), node("N2", 2, "octo/SUB", "old")],
      open: {
        "octo/repo": [{ nodes: [node("N1", 1), node("N3", 3)] }],
        "octo/sub": [{ nodes: [node("N2", 2, "octo/SUB", "old")] }],
      },
    });
    const r = await listed(repos);
    expect(r.map((p) => p.nodeId)).toEqual(["N1", "N3", "N2"]);
    expect(r[0]).toEqual({
      key: "h/octo/repo#1", repo: repos[0].repo, repoIdx: 2, remote: "origin", nodeId: "N1", number: 1,
      title: "t1", author: "alice", url: "https://h/Octo/Repo/pull/1", additions: 3, deletions: 1,
      headSha: "h1", baseSha: "b1", baseRef: "main", updatedAt: "2026-01-01T00:00:00Z",
      mine: "requested", myLastReviewSha: null, viewer: "me",
    });
    expect(r[1]).toMatchObject({ nodeId: "N3", mine: null, viewer: "me" });
    expect(r[2]).toMatchObject({ key: "h/octo/sub#2", repoIdx: 5, remote: "up", mine: "reviewed", myLastReviewSha: "old" });
  });

  it("keeps a viewer's PR missing from the open list (beyond the cap), once", async () => {
    serve({
      requested: [node("N9", 9), node("N9", 9)],
      reviewed: [node("N8", 8, "octo/sub")],
      open: { "octo/repo": [{ nodes: [node("N1", 1)] }] },
    });
    const r = await listed(repos);
    expect(r.map((p) => [p.nodeId, p.mine])).toEqual([["N1", null], ["N9", "requested"], ["N8", "reviewed"]]);
    expect(r[2]).toMatchObject({ key: "h/octo/sub#8", repoIdx: 5, viewer: "me" });
  });

  it("drops search hits of repos that aren't open", async () => {
    serve({ requested: [node("N1", 1, "other/x")] });
    expect(await listed(repos)).toEqual([]);
  });

  it("builds one repo: qualifier per open repo and one open-PR query per repo", async () => {
    serve({});
    await searchPrs("h", repos, "me");
    const qs = gql.mock.calls.filter((c) => String(c[1]).includes("search(")).map((c) => String(c[2].q));
    expect(qs).toEqual([
      "is:pr is:open review-requested:@me archived:false repo:octo/repo repo:octo/sub",
      "is:pr is:open reviewed-by:@me archived:false repo:octo/repo repo:octo/sub",
    ]);
    expect(openCalls().map((c) => c[2])).toEqual([
      { owner: "octo", name: "repo", login: "me", after: null },
      { owner: "octo", name: "sub", login: "me", after: null },
    ]);
    const q = String(openCalls()[0][1]);
    expect(q).toContain("pullRequests(states: OPEN, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC})");
    expect(q).toContain("pageInfo { hasNextPage endCursor }");
    expect(gql.mock.calls.every((c) => c[0] === "h" && c[2].login === "me")).toBe(true);
  });

  it("queries a GitHub repo open twice once, under its first entry", async () => {
    const twice = [repos[0], { ...repos[0], repo: { host: "h", owner: "Octo", name: "Repo" }, repoIdx: 7 }];
    serve({ open: { "octo/repo": [{ nodes: [node("N1", 1)] }] } });
    const r = await listed(twice);
    expect(openCalls()).toHaveLength(1);
    expect(r.map((p) => [p.key, p.repoIdx])).toEqual([["h/octo/repo#1", 2]]);
  });

  it("skips archived repos' open PRs, as the searches do", async () => {
    serve({ open: { "octo/repo": [{ nodes: [node("N1", 1)] }] }, archived: ["octo/repo"] });
    expect(await listed(repos)).toEqual([]);
  });

  it("last submitted review ignores pending, in both queries", async () => {
    serve({});
    await searchPrs("h", repos, "me");
    for (const c of gql.mock.calls) {
      expect(String(c[1])).toContain("states:[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]");
    }
  });

  it("a repo whose open-PR query fails is reported; the rest and the search hits stay", async () => {
    serve({
      requested: [node("N8", 8, "octo/sub")],
      open: { "octo/repo": [{ nodes: [node("N1", 1)] }] },
      fail: ["octo/sub"],
    });
    const r = await searchPrs("h", repos, "me");
    expect(r.prs.map((p) => [p.key, p.mine])).toEqual([["h/octo/repo#1", null], ["h/octo/sub#8", "requested"]]);
    expect(r.failedRepos).toEqual([{ repo: "octo/sub", message: "Error: boom octo/sub" }]);
  });

  it("a failing search still fails the host", async () => {
    gql.mockRejectedValue(new Error("search down"));
    await expect(searchPrs("h", repos, "me")).rejects.toThrow("search down");
  });

  it("lists a PR once when it shows on two open pages", async () => {
    serve({ open: { "octo/repo": [{ nodes: [node("N2", 2), node("N1", 1)] }, { nodes: [node("N1", 1), node("N3", 3)] }] } });
    expect((await listed(repos)).map((p) => p.nodeId)).toEqual(["N2", "N1", "N3"]);
  });

  it("marks reviewed a PR the viewer reviewed that the capped search missed", async () => {
    serve({ open: { "octo/repo": [{ nodes: [node("N1", 1, "octo/repo", "old"), node("N2", 2)] }] } });
    expect((await listed(repos)).map((p) => p.mine)).toEqual(["reviewed", null]);
  });

  describe("wanted keys beyond the cap", () => {
    it("fetches unlisted open ones by number; leaves out closed, listed and other repos' or hosts' keys", async () => {
      serve({
        open: { "octo/repo": [{ nodes: [node("N1", 1)] }] },
        byNumber: {
          "octo/repo#7": { state: "OPEN", node: node("N7", 7, "octo/repo", "s7") },
          "octo/sub#4": { state: "MERGED", node: node("N4", 4, "octo/sub") },
          "octo/sub#5": { state: "CLOSED", node: node("N5", 5, "octo/sub") },
        },
      });
      const r = await searchPrs("h", repos, "me", [
        "h/octo/repo#1", "h/octo/repo#7", "h/Octo/Sub#4", "h/octo/sub#5", "h/other/x#1", "g/octo/repo#2",
      ]);
      expect(r.prs.map((p) => [p.key, p.repoIdx, p.mine])).toEqual([
        ["h/octo/repo#1", 2, null],
        ["h/octo/repo#7", 2, "reviewed"],
      ]);
      expect(r.failedRepos).toEqual([]);
      expect(numberCalls().map((c) => c[2])).toEqual([
        { owner: "octo", name: "repo", number: 7, login: "me" },
        { owner: "octo", name: "sub", number: 4, login: "me" },
        { owner: "octo", name: "sub", number: 5, login: "me" },
      ]);
      expect(String(numberCalls()[0][1])).toContain("pullRequest(number: $number) { state");
      expect(String(numberCalls()[0][1])).toContain("states:[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]");
    });

    it("skips archived repos and repos whose open-PR query failed", async () => {
      serve({
        archived: ["octo/repo"],
        fail: ["octo/sub"],
        byNumber: { "octo/repo#7": { state: "OPEN", node: node("N7", 7) } },
      });
      const r = await searchPrs("h", repos, "me", ["h/octo/repo#7", "h/octo/sub#3"]);
      expect(r.prs).toEqual([]);
      expect(r.failedRepos.map((f) => f.repo)).toEqual(["octo/sub"]);
      expect(numberCalls().map((c) => c[2].number)).toEqual([7]);
    });

    it("a failing fetch reports its repo once and keeps the rest", async () => {
      serve({
        byNumber: {
          "octo/repo#7": new Error("nope"),
          "octo/repo#8": new Error("nope again"),
          "octo/sub#4": { state: "OPEN", node: node("N4", 4, "octo/sub") },
        },
      });
      const r = await searchPrs("h", repos, "me", ["h/octo/repo#7", "h/octo/repo#8", "h/octo/sub#4"]);
      expect(r.prs.map((p) => p.key)).toEqual(["h/octo/sub#4"]);
      expect(r.failedRepos).toEqual([{ repo: "octo/repo", message: "Error: nope" }]);
    });
  });

  it("no repos: no queries", async () => {
    expect(await searchPrs("h", [], "me", ["h/octo/repo#1"])).toEqual({ prs: [], failedRepos: [] });
    expect(gql).not.toHaveBeenCalled();
  });
});

describe("openPrs", () => {
  const entry = { repo: { host: "h", owner: "octo", name: "repo" }, repoIdx: 0, remote: "origin" };

  it("follows the cursor and stops after two pages (200 PRs)", async () => {
    serve({ open: { "octo/repo": [{ nodes: [node("A", 1)] }, { nodes: [node("B", 2)], more: true }, { nodes: [node("C", 3)] }] } });
    const r = await openPrs("h", entry, "me");
    expect(r.map((p) => p.nodeId)).toEqual(["A", "B"]);
    expect(gql.mock.calls.map((c) => c[2].after)).toEqual([null, "c1"]);
  });

  it("stops at the last page", async () => {
    serve({ open: { "octo/repo": [{ nodes: [node("A", 1)] }] } });
    const r = await openPrs("h", entry, "me");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ mine: null, viewer: "me", key: "h/octo/repo#1" });
    expect(gql).toHaveBeenCalledTimes(1);
  });

  it("maps a missing author to ghost and skips null nodes", async () => {
    serve({ open: { "octo/repo": [{ nodes: [{ ...node("A", 1), author: null as never }, null as never] }] } });
    const r = await openPrs("h", entry, "me");
    expect(r.map((p) => p.author)).toEqual(["ghost"]);
  });
});

describe("prDetail", () => {
  it("maps threads, ghost authors and pending review id", async () => {
    gql.mockResolvedValue({
      node: {
        body: "desc", headRefOid: "H", baseRefOid: "B",
        comments: { nodes: [{ id: "c1", author: null, body: "hi", createdAt: "t" }] },
        reviews: { nodes: [{ id: "R1", commit: { oid: "C1" } }] },
        reviewThreads: {
          nodes: [{
            id: "T1", isResolved: false, isOutdated: true, path: "a.ts", line: null, startLine: null,
            originalLine: 7, diffSide: "LEFT", startDiffSide: null, subjectType: "LINE",
            comments: { nodes: [{ id: "c2", author: { login: "bob" }, body: "x", createdAt: "t2" }] },
          }],
        },
      },
    } as never);
    const d = await prDetail("h", "PR1");
    expect(d).toEqual({
      body: "desc", headSha: "H", baseSha: "B", pendingReviewId: "R1", pendingReviewCommit: "C1",
      conversation: [{ id: "c1", author: "ghost", body: "hi", createdAt: "t" }],
      threads: [{
        id: "T1", path: "a.ts", side: "LEFT", line: null, startLine: null, originalLine: 7,
        isResolved: false, isOutdated: true, subjectType: "LINE",
        comments: [{ id: "c2", author: "bob", body: "x", createdAt: "t2" }],
      }],
    });
    expect(gql.mock.calls[0][2]).toEqual({ id: "PR1" });
  });

  it("pendingReviewCommit is null without a pending review or commit", async () => {
    const node = (reviews: unknown[]) => ({
      node: { body: "", headRefOid: "H", baseRefOid: "B", comments: { nodes: [] },
        reviews: { nodes: reviews }, reviewThreads: { nodes: [] } },
    });
    gql.mockResolvedValueOnce(node([]) as never).mockResolvedValueOnce(node([{ id: "R", commit: null }]) as never);
    expect((await prDetail("h", "P")).pendingReviewCommit).toBeNull();
    expect((await prDetail("h", "P")).pendingReviewCommit).toBeNull();
  });
});

describe("addThread", () => {
  it("sends FILE subject without line fields", async () => {
    gql.mockResolvedValue({} as never);
    await addThread("h", "R", { path: "a.ts", body: "b", subjectType: "FILE" });
    const input = (gql.mock.calls[0][2] as { input: Record<string, unknown> }).input;
    expect(input).toEqual({ pullRequestReviewId: "R", path: "a.ts", body: "b", subjectType: "FILE" });
  });

  it("sends startLine/startSide only for ranges", async () => {
    gql.mockResolvedValue({} as never);
    await addThread("h", "R", { path: "a", body: "b", subjectType: "LINE", side: "RIGHT", line: 9 });
    await addThread("h", "R", { path: "a", body: "b", subjectType: "LINE", side: "RIGHT", line: 9, startLine: 5, startSide: "RIGHT" });
    const inputs = gql.mock.calls.map((c) => (c[2] as { input: Record<string, unknown> }).input);
    expect(inputs[0]).toEqual({ pullRequestReviewId: "R", path: "a", body: "b", subjectType: "LINE", side: "RIGHT", line: 9 });
    expect(inputs[1]).toMatchObject({ startLine: 5, startSide: "RIGHT", line: 9 });
  });
});
