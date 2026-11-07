import { ghGraphql } from "./gh";
import type { GhRepo, PrDetail, PrSummary, ReviewEvent, ReviewThread, Side, ThreadComment } from "./types";

const viewerCache = new Map<string, Promise<string>>();

export function viewerLogin(host: string): Promise<string> {
  let p = viewerCache.get(host);
  if (!p) {
    p = ghGraphql<{ viewer: { login: string } }>(host, "query { viewer { login } }", {}).then(
      (d) => d.viewer.login,
    );
    p.catch(() => viewerCache.delete(host));
    viewerCache.set(host, p);
  }
  return p;
}

const SEARCH_QUERY = `query($q: String!, $login: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        id number title url additions deletions headRefOid baseRefOid baseRefName updatedAt
        author { login }
        repository { nameWithOwner }
        reviews(last: 1, author: $login) { nodes { commit { oid } } }
      }
    }
  }
}`;

interface SearchNode {
  id: string; number: number; title: string; url: string; additions: number; deletions: number;
  headRefOid: string; baseRefOid: string; baseRefName: string; updatedAt: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  reviews: { nodes: { commit: { oid: string } | null }[] };
}

export interface SearchRepo { repo: GhRepo; repoIdx: number; remote: string }

export async function searchPrs(host: string, repos: SearchRepo[], login: string): Promise<PrSummary[]> {
  if (repos.length === 0) return [];
  const quals = repos.map((r) => `repo:${r.repo.owner}/${r.repo.name}`).join(" ");
  const run = async (kind: string, section: PrSummary["section"]) => {
    const q = `is:pr is:open ${kind}:@me archived:false ${quals}`;
    const d = await ghGraphql<{ search: { nodes: (SearchNode | null)[] } }>(host, SEARCH_QUERY, { q, login });
    const out: PrSummary[] = [];
    for (const n of d.search.nodes) {
      if (!n || n.id == null) continue;
      const name = n.repository.nameWithOwner.toLowerCase();
      const entry = repos.find((r) => `${r.repo.owner}/${r.repo.name}`.toLowerCase() === name);
      if (!entry) continue;
      out.push({
        key: `${entry.repo.host}/${entry.repo.owner}/${entry.repo.name}#${n.number}`,
        repo: entry.repo, repoIdx: entry.repoIdx, remote: entry.remote,
        nodeId: n.id, number: n.number, title: n.title, author: n.author?.login ?? "ghost",
        url: n.url, additions: n.additions, deletions: n.deletions,
        headSha: n.headRefOid, baseSha: n.baseRefOid, baseRef: n.baseRefName, updatedAt: n.updatedAt,
        section, myLastReviewSha: n.reviews.nodes[0]?.commit?.oid ?? null,
      });
    }
    return out;
  };
  const [requested, reviewed] = await Promise.all([
    run("review-requested", "requested"),
    run("reviewed-by", "reviewed"),
  ]);
  const seen = new Set(requested.map((p) => p.key));
  return [...requested, ...reviewed.filter((p) => !seen.has(p.key))];
}

const DETAIL_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      body headRefOid baseRefOid
      comments(first: 100) { nodes { id author { login } body createdAt } }
      reviews(states: [PENDING], first: 1) { nodes { id } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line startLine originalLine diffSide startDiffSide subjectType
          comments(first: 100) { nodes { id author { login } body createdAt } }
        }
      }
    }
  }
}`;

interface RawComment { id: string; author: { login: string } | null; body: string; createdAt: string }

const mapComment = (c: RawComment): ThreadComment => ({
  id: c.id, author: c.author?.login ?? "ghost", body: c.body, createdAt: c.createdAt,
});

export async function prDetail(host: string, nodeId: string): Promise<PrDetail> {
  const d = await ghGraphql<{
    node: {
      body: string; headRefOid: string; baseRefOid: string;
      comments: { nodes: RawComment[] };
      reviews: { nodes: { id: string }[] };
      reviewThreads: {
        nodes: {
          id: string; isResolved: boolean; isOutdated: boolean; path: string;
          line: number | null; startLine: number | null; originalLine: number | null;
          diffSide: Side; subjectType: "LINE" | "FILE";
          comments: { nodes: RawComment[] };
        }[];
      };
    };
  }>(host, DETAIL_QUERY, { id: nodeId });
  const n = d.node;
  const threads: ReviewThread[] = n.reviewThreads.nodes.map((t) => ({
    id: t.id, path: t.path, side: t.diffSide, line: t.line, startLine: t.startLine,
    originalLine: t.originalLine, isResolved: t.isResolved, isOutdated: t.isOutdated,
    subjectType: t.subjectType, comments: t.comments.nodes.map(mapComment),
  }));
  return {
    body: n.body, headSha: n.headRefOid, baseSha: n.baseRefOid,
    conversation: n.comments.nodes.map(mapComment), threads,
    pendingReviewId: n.reviews.nodes[0]?.id ?? null,
  };
}

export async function createPendingReview(host: string, prNodeId: string, commitOid: string): Promise<string> {
  const d = await ghGraphql<{ addPullRequestReview: { pullRequestReview: { id: string } } }>(
    host,
    `mutation($input: AddPullRequestReviewInput!) {
      addPullRequestReview(input: $input) { pullRequestReview { id } }
    }`,
    { input: { pullRequestId: prNodeId, commitOID: commitOid } },
  );
  return d.addPullRequestReview.pullRequestReview.id;
}

export interface NewThread {
  path: string; body: string; side?: Side; line?: number; startLine?: number; startSide?: Side;
  subjectType: "LINE" | "FILE";
}

export async function addThread(host: string, reviewId: string, t: NewThread): Promise<void> {
  const input: Record<string, unknown> = {
    pullRequestReviewId: reviewId, path: t.path, body: t.body, subjectType: t.subjectType,
  };
  if (t.subjectType === "LINE") {
    input.side = t.side;
    input.line = t.line;
    if (t.startLine != null) {
      input.startLine = t.startLine;
      input.startSide = t.startSide ?? t.side;
    }
  }
  await ghGraphql(
    host,
    `mutation($input: AddPullRequestReviewThreadInput!) {
      addPullRequestReviewThread(input: $input) { thread { id } }
    }`,
    { input },
  );
}

export async function addReply(host: string, reviewId: string, threadId: string, body: string): Promise<void> {
  await ghGraphql(
    host,
    `mutation($input: AddPullRequestReviewThreadReplyInput!) {
      addPullRequestReviewThreadReply(input: $input) { comment { id } }
    }`,
    { input: { pullRequestReviewId: reviewId, pullRequestReviewThreadId: threadId, body } },
  );
}

export async function submitReview(host: string, reviewId: string, event: ReviewEvent, body: string): Promise<void> {
  await ghGraphql(
    host,
    `mutation($input: SubmitPullRequestReviewInput!) {
      submitPullRequestReview(input: $input) { pullRequestReview { id } }
    }`,
    { input: { pullRequestReviewId: reviewId, event, body } },
  );
}

export async function deletePendingReview(host: string, reviewId: string): Promise<void> {
  await ghGraphql(
    host,
    `mutation($input: DeletePullRequestReviewInput!) {
      deletePullRequestReview(input: $input) { pullRequestReview { id } }
    }`,
    { input: { pullRequestReviewId: reviewId } },
  );
}

const RESOLVE_MUTATION = `mutation($input: ResolveReviewThreadInput!) {
  resolveReviewThread(input: $input) { thread { id } }
}`;
const UNRESOLVE_MUTATION = `mutation($input: UnresolveReviewThreadInput!) {
  unresolveReviewThread(input: $input) { thread { id } }
}`;

export async function setThreadResolved(host: string, threadId: string, resolved: boolean): Promise<void> {
  await ghGraphql(host, resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { input: { threadId } });
}
