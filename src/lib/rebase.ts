import { appState } from "./store.svelte";
// `rebasePlan` is the query; `appState.rebasePlan` is the plan being edited.
import { rebase, rebaseInteractive, rebasePlan as loadPlan } from "./git";
import {
  AUTOSTASH_CONFLICT_NOTE,
  loadCurrentBranch,
  loadPendingOp,
  refreshActiveView,
} from "./workingCopy";
import { reloadBranchesFor } from "./workspace";
import { confirmAction } from "./dialogs";
import { classifyGitError } from "./gitError";
import type { RebaseStep } from "./types";

/// Short label for a rebase target: a ref keeps its name, a raw SHA is
/// abbreviated the way the graph shows it.
function shortTarget(target: string): string {
  return /^[0-9a-f]{7,40}$/.test(target) ? target.slice(0, 7) : target;
}

/// Refresh everything a rebase can move: the active view, the branch chip, the
/// refs sidebar, and the conflict banner (a stopped rebase leaves an op
/// pending). Mirrors refreshAfterCheckout — a rebase moves HEAD too.
async function refreshAfterRebase(): Promise<void> {
  await refreshActiveView();
  void loadCurrentBranch();
  // Awaited, unlike the rest: runRebase reads pendingOp straight afterwards to
  // decide whether a failure is a paused rebase or a real error.
  await loadPendingOp();
  void reloadBranchesFor(appState.changesRepoIdx);
}

/// Run one rebase invocation and refresh. Both entry points funnel through
/// here so a conflict, a dirty tree, and a clean finish are reported the same
/// way wherever the rebase was started from.
async function runRebase(run: () => Promise<boolean>): Promise<void> {
  appState.error = null;
  appState.beginGitOp("Rebasing…");
  try {
    // The rebase can succeed and still leave the restored local changes in
    // conflicts; that is the only thing this flag reports.
    const autostashConflicted = await run();
    await refreshAfterRebase();
    if (autostashConflicted) appState.error = AUTOSTASH_CONFLICT_NOTE;
  } catch (e) {
    const raw = String(e);
    // A conflict is not a failure to report as one: the rebase is paused and
    // the conflict banner takes over from here, so leave the screen to it.
    await refreshAfterRebase();
    if (appState.pendingOp === "rebase") return;
    appState.error =
      classifyGitError(raw).kind === "unknown"
        ? raw
        : `${raw}\n\n변경을 정리한 뒤 다시 시도하세요. 커밋과 stash는 Fork에서 할 수 있습니다.`;
  } finally {
    appState.endGitOp();
  }
}

/// Replay `branch` (null = the current branch) onto `upstream`, after
/// confirming — this rewrites commits, so the prompt says how many and where
/// they can be recovered from.
export async function requestRebase(
  repoPath: string,
  upstream: string,
  branch: string | null,
): Promise<void> {
  const what = branch ?? appState.currentBranch ?? "HEAD";
  const commits = await planFor(repoPath, upstream, branch);
  if (commits === null) return;
  if (commits.length === 0) {
    appState.error = `${what} has nothing to replay onto ${shortTarget(upstream)} — it is already up to date.`;
    return;
  }
  // Rebasing a branch you are not on ends with that branch checked out —
  // git's own behaviour, worth saying before the fact rather than after.
  const switches =
    branch && branch !== appState.currentBranch
      ? `\n\nriff will end up on ${branch}.`
      : "";
  const ok = await confirmAction(
    `Rebase ${what} onto ${shortTarget(upstream)}?\n\n` +
      `${commits.length} commit${commits.length === 1 ? "" : "s"} will be rewritten. ` +
      `The pre-rebase tip stays recoverable from the reflog (Ctrl+Shift+R).` +
      switches,
    { title: "Rebase" },
  );
  if (!ok) return;
  await runRebase(() => rebase(repoPath, upstream, branch));
}

/// Load the commits a rebase would replay. Returns null when the query itself
/// failed (the error is already on screen), which callers treat as "stop".
async function planFor(repoPath: string, upstream: string, branch: string | null) {
  try {
    return await loadPlan(repoPath, upstream, branch ?? "");
  } catch (e) {
    appState.error = String(e);
    return null;
  }
}

/// Open the plan editor for `branch` (null = current) onto `upstream`. The
/// overlay is the confirmation for an interactive rebase — nothing runs until
/// the user starts it there.
export async function openRebasePlan(
  repoPath: string,
  upstream: string,
  branch: string | null,
): Promise<void> {
  const commits = await planFor(repoPath, upstream, branch);
  if (commits === null) return;
  const what = branch ?? appState.currentBranch ?? "HEAD";
  if (commits.length === 0) {
    appState.error = `${what} has nothing to replay onto ${shortTarget(upstream)} — it is already up to date.`;
    return;
  }
  appState.rebasePlan = {
    repoPath,
    upstream,
    branch,
    label: `${what} onto ${shortTarget(upstream)}`,
    commits,
  };
}

/// Run the plan assembled in the overlay and close it.
export async function startRebasePlan(steps: RebaseStep[]): Promise<void> {
  const plan = appState.rebasePlan;
  if (!plan) return;
  appState.rebasePlan = null;
  await runRebase(() =>
    rebaseInteractive(plan.repoPath, plan.upstream, plan.branch, steps),
  );
}
