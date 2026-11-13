import { isAiKey } from "./ai/aiStore";
import { ghStatus, gitRemotes } from "./gh";
import { searchPrs, viewerLogin, type FailedRepo, type SearchRepo } from "./github";
import { parseRemote } from "./remote";
import type { PrKey, PrRecord, PrSummary } from "./types";

export const REFRESH_MS = 300_000;

/** `failedRepos`: on a ready host, repos whose PRs couldn't all be loaded. */
export type HostState = {
  host: string;
  status: "ready" | "notinstalled" | "notloggedin" | "error";
  message: string | null;
  failedRepos?: FailedRepo[];
};

type RemotesOf = (path: string) => Promise<{ name: string; url: string }[]>;

export const loginHint = (host: string): string => `gh auth login --hostname ${host}`;

/** Per repo: the `origin` remote if it parses, else the first remote that does. */
export async function collectRepos(
  repos: { path: string }[],
  remotesOf: RemotesOf,
): Promise<Map<string, SearchRepo[]>> {
  const out = new Map<string, SearchRepo[]>();
  const found = await Promise.all(
    repos.map(async (r, repoIdx): Promise<SearchRepo | null> => {
      let remotes: { name: string; url: string }[];
      try {
        remotes = await remotesOf(r.path);
      } catch {
        return null;
      }
      const ordered = [
        ...remotes.filter((x) => x.name === "origin"),
        ...remotes.filter((x) => x.name !== "origin"),
      ];
      for (const rm of ordered) {
        const repo = parseRemote(rm.url);
        if (repo) return { repo, repoIdx, remote: rm.name };
      }
      return null;
    }),
  );
  for (const f of found) {
    if (!f) continue;
    const list = out.get(f.repo.host) ?? [];
    list.push(f);
    out.set(f.repo.host, list);
  }
  return out;
}

/**
 * `wanted`: keys to keep listed while still open, even beyond the open-PR cap.
 * `githubRepos`: open repos with a GitHub-like remote.
 */
export async function loadPrList(
  repos: { path: string }[],
  wanted: PrKey[] = [],
  remotesOf: RemotesOf = gitRemotes,
): Promise<{ prs: PrSummary[]; hosts: HostState[]; githubRepos: number }> {
  const byHost = await collectRepos(repos, remotesOf);
  const results = await Promise.all(
    [...byHost].map(async ([host, entries]): Promise<{ state: HostState; prs: PrSummary[] }> => {
      try {
        const status = await ghStatus(host);
        if (status !== "ready") return { state: { host, status, message: null }, prs: [] };
        const login = await viewerLogin(host);
        const { prs, failedRepos } = await searchPrs(host, entries, login, wanted);
        return { state: { host, status: "ready", message: null, failedRepos }, prs };
      } catch (e) {
        return { state: { host, status: "error", message: String(e) }, prs: [] };
      }
    }),
  );
  return {
    prs: results.flatMap((r) => r.prs),
    hosts: results.map((r) => r.state),
    githubRepos: [...byHost.values()].reduce((n, e) => n + e.length, 0),
  };
}

/** The PR list's row for a host that isn't ready. */
export function hostProblemText(h: HostState): {
  title: string;
  detail: string | null;
  canSignIn: boolean;
} {
  switch (h.status) {
    case "notloggedin":
      return { title: `Not signed in to ${h.host}`, detail: null, canSignIn: true };
    case "notinstalled":
      return {
        title: "GitHub CLI (gh) not found",
        detail: "Install it from https://cli.github.com, then press Refresh.",
        canSignIn: false,
      };
    default:
      return { title: `Couldn't load pull requests from ${h.host}`, detail: h.message, canSignIn: false };
  }
}

export type ListEmptyState = "no-github-repos" | "no-prs";

export function listEmptyState(
  githubRepoCount: number,
  hosts: HostState[],
  prCount: number,
): ListEmptyState | null {
  if (githubRepoCount === 0) return "no-github-repos";
  if (prCount === 0 && hosts.some((h) => h.status === "ready")) return "no-prs";
  return null;
}

/** The unseen head move: viewed head differs from the displayed head. */
export function headMoveFor(r: PrRecord, headSha: string): { from: string; to: string } | null {
  return r.viewedHead !== null && r.viewedHead !== headSha ? { from: r.viewedHead, to: headSha } : null;
}

/**
 * The selected PR's listed head differs from the displayed `headSha`: the
 * `headMoved` to set, or null to leave it as it is.
 */
export function listedHeadMove(
  prs: Pick<PrSummary, "key" | "headSha">[],
  selectedKey: PrKey | null,
  headSha: string | null,
  current: { from: string; to: string } | null,
): { from: string; to: string } | null {
  const listed = prs.find((p) => p.key === selectedKey)?.headSha;
  if (!headSha || !listed || listed === headSha || current?.to === listed) return null;
  return { from: headSha, to: listed };
}

const hasDraft = (r: PrRecord): boolean => r.items.length > 0 || r.body.trim() !== "";

/** Keys to keep listed: the selected PR and stored records holding a draft (or unreadable). */
export function wantedKeys(records: Map<string, PrRecord | null>, selected: PrKey | null): PrKey[] {
  const out = [...records].filter(([k, r]) => !isAiKey(k) && (!r || hasDraft(r))).map(([k]) => k);
  return selected !== null && !out.includes(selected) ? [selected, ...out] : out;
}

/**
 * Stored records safe to delete: unlisted, no items, no body text, host ready
 * in this refresh and the PR's repo loaded. `records` maps key to the record,
 * or null when unreadable.
 */
export function keysToDelete(
  keys: string[],
  records: Map<string, PrRecord | null>,
  listed: Set<PrKey>,
  hosts: HostState[],
): string[] {
  const ready = new Set(hosts.filter((h) => h.status === "ready").map((h) => h.host));
  const failed = new Set(
    hosts.flatMap((h) => (h.failedRepos ?? []).map((f) => `${h.host}/${f.repo}`.toLowerCase())),
  );
  return keys.filter((k) => {
    if (isAiKey(k) || listed.has(k)) return false;
    if (!ready.has(k.slice(0, k.indexOf("/")))) return false;
    if (failed.has(k.slice(0, k.lastIndexOf("#")).toLowerCase())) return false;
    const r = records.get(k);
    return !!r && !hasDraft(r);
  });
}
