import { ghStatus, gitRemotes } from "./gh";
import { searchPrs, viewerLogin, type SearchRepo } from "./github";
import { parseRemote } from "./remote";
import type { PrKey, PrRecord, PrSummary } from "./types";

export const REFRESH_MS = 300_000;

export type HostState = {
  host: string;
  status: "ready" | "notinstalled" | "notloggedin" | "error";
  message: string | null;
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

export async function loadPrList(
  repos: { path: string }[],
  remotesOf: RemotesOf = gitRemotes,
): Promise<{ prs: PrSummary[]; hosts: HostState[] }> {
  const byHost = await collectRepos(repos, remotesOf);
  const results = await Promise.all(
    [...byHost].map(async ([host, entries]): Promise<{ state: HostState; prs: PrSummary[] }> => {
      try {
        const status = await ghStatus(host);
        if (status !== "ready") {
          const message =
            status === "notinstalled"
              ? `The gh CLI is not installed. Install it, then run ${loginHint(host)}`
              : `Not logged in to ${host}. Run ${loginHint(host)}`;
          return { state: { host, status, message }, prs: [] };
        }
        const login = await viewerLogin(host);
        const prs = await searchPrs(host, entries, login);
        return { state: { host, status: "ready", message: null }, prs };
      } catch (e) {
        return { state: { host, status: "error", message: String(e) }, prs: [] };
      }
    }),
  );
  return { prs: results.flatMap((r) => r.prs), hosts: results.map((r) => r.state) };
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

/**
 * Stored records safe to delete: unlisted, no items, no body text, host ready
 * in this refresh. `records` maps key to the record, or null when unreadable.
 */
export function keysToDelete(
  keys: string[],
  records: Map<string, PrRecord | null>,
  listed: Set<PrKey>,
  hosts: HostState[],
): string[] {
  const ready = new Set(hosts.filter((h) => h.status === "ready").map((h) => h.host));
  return keys.filter((k) => {
    if (listed.has(k)) return false;
    if (!ready.has(k.slice(0, k.indexOf("/")))) return false;
    const r = records.get(k);
    return !!r && r.items.length === 0 && r.body.trim() === "";
  });
}
