import { appState } from "./store.svelte";
import { submoduleShaAt } from "./git";
import type { RepoEntry, RepoRange } from "./types";

/// Resolve which two refs `repo` compares, and why. `base` / `compare` are the
/// toolbar pair (the super repo's), `mainPath` the super repo whose gitlinks
/// pin a submodule. This is the one rule compare(), the commit table, DiffView
/// and every range label follow.
export async function resolveRepoRange(
  repo: RepoEntry,
  mainPath: string,
  base: string,
  compare: string,
): Promise<RepoRange> {
  if (repo.kind === "main") {
    if (!base || !compare) return { ok: false, reason: "no-refs" };
    return { ok: true, path: repo.path, base, compare, source: "toolbar" };
  }
  if (repo.override) {
    const { startBranch, targetBranch } = repo.override;
    if (!startBranch || !targetBranch) return { ok: false, reason: "no-refs" };
    return {
      ok: true,
      path: repo.path,
      base: startBranch,
      compare: targetBranch,
      source: "override",
    };
  }
  if (!base || !compare) return { ok: false, reason: "no-refs" };
  if (repo.kind === "manual") {
    return { ok: true, path: repo.path, base, compare, source: "same-name" };
  }
  if (!repo.parentGitlinkPath) return { ok: false, reason: "absent" };
  let basePin: string | null;
  let comparePin: string | null;
  try {
    [basePin, comparePin] = await Promise.all([
      submoduleShaAt(mainPath, base, repo.parentGitlinkPath),
      submoduleShaAt(mainPath, compare, repo.parentGitlinkPath),
    ]);
  } catch (e) {
    return { ok: false, reason: "error", message: String(e) };
  }
  if (!basePin && !comparePin) return { ok: false, reason: "absent" };
  if (!basePin) return { ok: false, reason: "added", pin: comparePin ?? undefined };
  if (!comparePin) return { ok: false, reason: "removed", pin: basePin };
  if (basePin === comparePin) {
    return { ok: false, reason: "unchanged", pin: basePin };
  }
  return {
    ok: true,
    path: repo.path,
    base: basePin,
    compare: comparePin,
    source: "gitlink",
  };
}

/// The repos a resolution covers: the workspace, or main alone before the
/// workspace is built (compare() has the same fallback, so indexes line up).
function workspaceRepos(): RepoEntry[] {
  return appState.repos.length > 0
    ? appState.repos
    : [{ path: appState.repoPath, kind: "main", displayName: "" }];
}

function inputsKey(repos: RepoEntry[]): string {
  return JSON.stringify([
    appState.startBranch,
    appState.targetBranch,
    appState.refsRefresh,
    repos.map((r) => [
      r.path,
      r.kind,
      r.parentGitlinkPath ?? "",
      r.override ?? null,
    ]),
  ]);
}

let lastKey: string | null = null;
let lastRun: Promise<RepoRange[]> | null = null;

/// Resolve every repo's range and publish it to `appState.repoRanges`. Runs
/// again only when an input changed — the toolbar pair, the repo list or an
/// override, or `refsRefresh` (the repo moved) — so every caller in between
/// shares one resolution, and therefore one answer.
export function resolveRepoRanges(): Promise<RepoRange[]> {
  const repos = workspaceRepos();
  const key = inputsKey(repos);
  if (lastRun && key === lastKey) return lastRun;
  lastKey = key;
  const mainPath = repos[0].path;
  const base = appState.startBranch;
  const compare = appState.targetBranch;
  const run: Promise<RepoRange[]> = Promise.all(
    repos.map((r) => resolveRepoRange(r, mainPath, base, compare)),
  ).then((ranges) => {
    // A newer resolution may have started meanwhile; only the latest publishes.
    if (lastRun === run) appState.repoRanges = ranges;
    return ranges;
  });
  lastRun = run;
  return run;
}

/// Test seam: forget the memoized resolution.
export function resetRepoRanges(): void {
  lastKey = null;
  lastRun = null;
}
