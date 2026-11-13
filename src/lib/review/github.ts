import { ghGraphql } from "./gh";
import type { GhRepo, PrDetail, PrKey, PrSummary, ReviewEvent, ReviewThread, Side, ThreadComment } from "./types";

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

const toKey = (entry: SearchRepo, number: number): PrKey =>
  `${entry.repo.host}/${entry.repo.owner}/${entry.repo.name}#${number}`;

function toSummary(n: PrNode, entry: SearchRepo, viewer: string): PrSummary {
  return {
    key: toKey(entry, n.number),
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

const NUMBER_QUERY = `query($owner: String!, $name: String!, $number: Int!, $login: String!) {
  repository(owner: $owner, name: $name) {
    isArchived
    pullRequest(number: $number) { state ${PR_FIELDS} }
  }
}`;

/** `owner/name` of a repo whose PRs couldn't all be loaded, and why. */
export interface FailedRepo { repo: string; message: string }

/** `entry`'s PR `number` if it is open (and the repo not archived), else null. */
async function prByNumber(host: string, entry: SearchRepo, number: number, login: string): Promise<PrSummary | null> {
  const d = await ghGraphql<{ repository: { isArchived: boolean; pullRequest: (PrNode & { state: string }) | null } }>(
    host, NUMBER_QUERY, { owner: entry.repo.owner, name: entry.repo.name, number, login },
  );
  const n = d.repository.pullRequest;
  return !d.repository.isArchived && n?.state === "OPEN" ? toSummary(n, entry, login) : null;
}

/**
 * Every open PR of `repos` (see `openPrs`), each marked `mine` by the two `@me`
 * searches, which also cover team review requests, or by the viewer's last review.
 * A PR of the viewer's beyond the open-PR cap still comes from its search; a
 * `wanted` key of this host beyond it is fetched by number (if still open). A GitHub
 * repo open twice is listed once, under its first entry. A repo whose PRs fail to
 * load is reported in `failedRepos`, the rest still listed; a failed search throws.
 */
export async function searchPrs(
  host: string,
  repos: SearchRepo[],
  login: string,
  wanted: PrKey[] = [],
): Promise<{ prs: PrSummary[]; failedRepos: FailedRepo[] }> {
  if (repos.length === 0) return { prs: [], failedRepos: [] };
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
  const failed = new Map<SearchRepo, string>();
  const [requested, reviewed, ...open] = await Promise.all([
    search("review-requested"),
    search("reviewed-by"),
    ...unique.map((r) =>
      openPrs(host, r, login).catch((e): PrSummary[] => {
        failed.set(r, String(e));
        return [];
      }),
    ),
  ]);
  const byKey = new Map<PrKey, PrSummary>();
  for (const p of [...open.flat(), ...requested, ...reviewed]) if (!byKey.has(p.key)) byKey.set(p.key, p);
  const fetched = await Promise.all(
    [...new Set(wanted)].map(async (key): Promise<PrSummary | null> => {
      const sep = key.lastIndexOf("#");
      if (!key.startsWith(`${host}/`) || sep < 0) return null;
      const name = key.slice(host.length + 1, sep).toLowerCase();
      const entry = unique.find((r) => nameOf(r) === name);
      const number = Number(key.slice(sep + 1));
      if (!entry || failed.has(entry) || !Number.isInteger(number)) return null;
      if (byKey.has(toKey(entry, number))) return null;
      try {
        return await prByNumber(host, entry, number, login);
      } catch (e) {
        if (!failed.has(entry)) failed.set(entry, String(e));
        return null;
      }
    }),
  );
  for (const p of fetched) if (p && !byKey.has(p.key)) byKey.set(p.key, p);
  const mine = new Map<string, PrSummary["mine"]>();
  for (const p of reviewed) mine.set(p.key, "reviewed");
  for (const p of requested) mine.set(p.key, "requested");
  const prs = [...byKey.values()].map((p) => ({
    ...p,
    // The searches are capped: a submitted review of the viewer's also counts, except on
    // the viewer's own PRs, where replying to a review comment records a review too.
    mine: mine.get(p.key)
      ?? (p.myLastReviewSha !== null && p.author.toLowerCase() !== login.toLowerCase() ? "reviewed" : null),
  }));
  const failedRepos = unique
    .filter((r) => failed.has(r))
    .map((r) => ({ repo: `${r.repo.owner}/${r.repo.name}`, message: failed.get(r)! }));
  return { prs, failedRepos };
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
