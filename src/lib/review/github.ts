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

/** A PullRequest's list fields; needs `$login` (the viewer, for the last submitted review). */
const PR_FIELDS = `id number title url additions deletions headRefOid baseRefOid baseRefName updatedAt
        author { login }
        repository { nameWithOwner }
        reviews(last:1, author:$login, states:[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) { nodes { commit { oid } } }`;

const SEARCH_QUERY = `query($q: String!, $login: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        ${PR_FIELDS}
      }
    }
  }
}`;

const OPEN_QUERY = `query($owner: String!, $name: String!, $login: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    isArchived
    pullRequests(states: OPEN, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PR_FIELDS}
      }
    }
  }
}`;

/** Per repo, the most recently updated open PRs listed: 2 pages of 100. */
const OPEN_PAGES = 2;

interface PrNode {
  id: string; number: number; title: string; url: string; additions: number; deletions: number;
  headRefOid: string; baseRefOid: string; baseRefName: string; updatedAt: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  reviews: { nodes: { commit: { oid: string } | null }[] };
}

export interface SearchRepo { repo: GhRepo; repoIdx: number; remote: string }

const nameOf = (r: SearchRepo): string => `${r.repo.owner}/${r.repo.name}`.toLowerCase();

function toSummary(n: PrNode, entry: SearchRepo, viewer: string): PrSummary {
  return {
    key: `${entry.repo.host}/${entry.repo.owner}/${entry.repo.name}#${n.number}`,
    repo: entry.repo, repoIdx: entry.repoIdx, remote: entry.remote,
    nodeId: n.id, number: n.number, title: n.title, author: n.author?.login ?? "ghost",
    url: n.url, additions: n.additions, deletions: n.deletions,
    headSha: n.headRefOid, baseSha: n.baseRefOid, baseRef: n.baseRefName, updatedAt: n.updatedAt,
    mine: null, myLastReviewSha: n.reviews.nodes[0]?.commit?.oid ?? null, viewer,
  };
}

/** `entry`'s open PRs, most recently updated first, at most `OPEN_PAGES` pages; none when archived. */
export async function openPrs(host: string, entry: SearchRepo, login: string): Promise<PrSummary[]> {
  const out: PrSummary[] = [];
  let after: string | null = null;
  for (let page = 0; page < OPEN_PAGES; page++) {
    const d: {
      repository: {
        isArchived: boolean;
        pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (PrNode | null)[] };
      };
    } = await ghGraphql(host, OPEN_QUERY, { owner: entry.repo.owner, name: entry.repo.name, login, after });
    if (d.repository.isArchived) return [];
    const { pageInfo, nodes } = d.repository.pullRequests;
    for (const n of nodes) if (n) out.push(toSummary(n, entry, login));
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return out;
}

/**
 * Every open PR of `repos` (see `openPrs`), each marked `mine` by the two `@me`
 * searches, which also cover team review requests. A PR of the viewer's beyond the
 * open-PR cap still comes from its search. A GitHub repo open twice is listed once,
 * under its first entry.
 */
export async function searchPrs(host: string, repos: SearchRepo[], login: string): Promise<PrSummary[]> {
  if (repos.length === 0) return [];
  const unique = repos.filter((r, i) => repos.findIndex((x) => nameOf(x) === nameOf(r)) === i);
  const quals = unique.map((r) => `repo:${r.repo.owner}/${r.repo.name}`).join(" ");
  const search = async (kind: string): Promise<PrSummary[]> => {
    const q = `is:pr is:open ${kind}:@me archived:false ${quals}`;
    const d = await ghGraphql<{ search: { nodes: (PrNode | null)[] } }>(host, SEARCH_QUERY, { q, login });
    const out: PrSummary[] = [];
    for (const n of d.search.nodes) {
      if (!n || n.id == null) continue;
      const name = n.repository.nameWithOwner.toLowerCase();
      const entry = unique.find((r) => nameOf(r) === name);
      if (entry) out.push(toSummary(n, entry, login));
    }
    return out;
  };
  const [requested, reviewed, ...open] = await Promise.all([
    search("review-requested"),
    search("reviewed-by"),
    ...unique.map((r) => openPrs(host, r, login)),
  ]);
  const mine = new Map<string, PrSummary["mine"]>();
  for (const p of reviewed) mine.set(p.key, "reviewed");
  for (const p of requested) mine.set(p.key, "requested");
  const out = open.flat();
  const listed = new Set(out.map((p) => p.key));
  for (const p of [...requested, ...reviewed]) {
    if (listed.has(p.key)) continue;
    listed.add(p.key);
    out.push(p);
  }
  return out.map((p) => ({ ...p, mine: mine.get(p.key) ?? null }));
}

const DETAIL_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      body headRefOid baseRefOid
      comments(first: 100) { nodes { id author { login } body createdAt } }
      reviews(states: [PENDING], first: 1) { nodes { id commit { oid } } }
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
      reviews: { nodes: { id: string; commit: { oid: string } | null }[] };
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
    pendingReviewCommit: n.reviews.nodes[0]?.commit?.oid ?? null,
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
