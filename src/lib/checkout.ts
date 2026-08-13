import { appState } from "./store.svelte";
import { checkout, fastForward, fetch as fetchRemotes } from "./git";
import {
  refreshActiveView,
  loadCurrentBranch,
  loadPendingOp,
} from "./workingCopy";
import { reloadBranchesFor } from "./workspace";
import { classifyGitError } from "./gitError";

/// Refresh everything a branch switch can affect: the active view (graph /
/// status + branch chip), the refs sidebar, and any pending operation banner.
async function refreshAfterCheckout(): Promise<void> {
  await refreshActiveView();
  void loadCurrentBranch();
  void loadPendingOp();
  void reloadBranchesFor(appState.changesRepoIdx);
}

/// Switch branches and refresh on success. Throws on failure so the caller can
/// surface it. When `ffTo` is set (a remote ref), this is a real "pull": the
/// remote is fetched and the just-switched local branch is fast-forwarded up to
/// it — used for remote-branch double-clicks so a behind local catches up to
/// the server. A fetch (offline) or fast-forward (diverged) failure is surfaced
/// but doesn't undo the completed switch.
export async function runCheckout(
  repoPath: string,
  target: string,
  ffTo?: string,
): Promise<void> {
  appState.error = null;
  appState.beginGitOp(ffTo ? "Pulling…" : "Checking out…");
  try {
    await checkout(repoPath, target);
    if (ffTo) {
      try {
        await fetchRemotes(repoPath);
        await fastForward(repoPath, ffTo);
      } catch (e) {
        appState.error = `Switched to ${target}, but couldn't update to ${ffTo}: ${e}`;
      }
    }
    // Preserve a fetch/ff error across the refresh — loadStatus/loadCommits
    // clear appState.error, which would otherwise swallow the message.
    const err = appState.error;
    await refreshAfterCheckout();
    if (err) appState.error = err;
  } finally {
    appState.endGitOp();
  }
}

/// Entry point for every checkout affordance. riff does not stash, discard, or
/// force — it runs the switch and reports what git said. When git refused
/// because local changes are in the way, add the one line that tells the user
/// what to do about it; anything else stands on its own.
export async function requestCheckout(
  repoPath: string,
  target: string,
  ffTo?: string,
): Promise<void> {
  try {
    await runCheckout(repoPath, target, ffTo);
  } catch (e) {
    const raw = String(e);
    const kind = classifyGitError(raw).kind;
    appState.error =
      kind === "unknown"
        ? raw
        : `${raw}\n\n변경을 정리한 뒤 다시 시도하세요. 커밋과 stash는 Fork에서 할 수 있습니다.`;
    void loadPendingOp();
  }
}
