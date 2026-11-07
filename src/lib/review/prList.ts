import { ghStatus, gitRemotes } from "./gh";
import { searchPrs, viewerLogin, type SearchRepo } from "./github";
import { parseRemote } from "./remote";
import type { PrSummary } from "./types";

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
