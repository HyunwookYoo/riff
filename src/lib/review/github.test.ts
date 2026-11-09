import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gh", () => ({ ghGraphql: vi.fn() }));

import { ghGraphql } from "./gh";
import { addThread, prDetail, searchPrs } from "./github";

const gql = vi.mocked(ghGraphql);

function node(id: string, number: number, repo = "Octo/Repo", reviewSha: string | null = null) {
  return {
    id, number, title: `t${number}`, author: { login: "alice" }, url: `https://h/${repo}/pull/${number}`,
    additions: 3, deletions: 1, headRefOid: "h" + number, baseRefOid: "b" + number, baseRefName: "main",
    updatedAt: "2026-01-01T00:00:00Z", repository: { nameWithOwner: repo },
    reviews: { nodes: reviewSha ? [{ commit: { oid: reviewSha } }] : [] },
  };
}

beforeEach(() => gql.mockReset());

describe("searchPrs", () => {
  const repos = [
    { repo: { host: "h", owner: "octo", name: "repo" }, repoIdx: 2, remote: "origin" },
    { repo: { host: "h", owner: "octo", name: "sub" }, repoIdx: 5, remote: "up" },
  ];

  it("maps fields and dedupes reviewed against requested", async () => {
    gql
      .mockResolvedValueOnce({ search: { nodes: [node("N1", 1)] } } as never)
      .mockResolvedValueOnce({ search: { nodes: [node("N1", 1), node("N2", 2, "octo/SUB", "old")] } } as never);
    const r = await searchPrs("h", repos, "me");
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      key: "h/octo/repo#1", repoIdx: 2, remote: "origin", nodeId: "N1", number: 1, title: "t1",
      author: "alice", additions: 3, deletions: 1, headSha: "h1", baseSha: "b1", baseRef: "main",
      section: "requested", myLastReviewSha: null,
    });
    expect(r[1]).toMatchObject({ nodeId: "N2", repoIdx: 5, remote: "up", section: "reviewed", myLastReviewSha: "old" });
  });

  it("builds one repo: qualifier per open repo", async () => {
    gql.mockResolvedValue({ search: { nodes: [] } } as never);
    await searchPrs("h", repos, "me");
    const qs = gql.mock.calls.map((c) => String(c[2].q));
    expect(qs).toHaveLength(2);
    expect(qs[0]).toBe("is:pr is:open review-requested:@me archived:false repo:octo/repo repo:octo/sub");
    expect(qs[1]).toBe("is:pr is:open reviewed-by:@me archived:false repo:octo/repo repo:octo/sub");
    expect(gql.mock.calls[0][2].login).toBe("me");
  });

  it("last submitted review ignores pending", async () => {
    gql.mockResolvedValue({ search: { nodes: [] } } as never);
    await searchPrs("h", repos, "me");
    expect(String(gql.mock.calls[0][1])).toContain("states:[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]");
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
