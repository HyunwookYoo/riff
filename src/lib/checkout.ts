import { appState } from "./store.svelte";
import {
  status,
  checkout,
  forceCheckout,
  stashCheckout,
  fastForward,
} from "./git";
import {
  refreshActiveView,
  loadCurrentBranch,
  loadStashes,
  loadPendingOp,
} from "./sourceControl";
import { reloadBranchesFor } from "./workspace";

/// How to handle uncommitted changes when switching branches:
/// - `bring`: carry them over (`git checkout`) — fails if they conflict.
/// - `stash`: stash, switch, then reapply (`git stash pop`).
/// - `discard`: throw away tracked changes (`git checkout -f`). Destructive.
export type CheckoutStrategy = "bring" | "stash" | "discard";

async function isDirty(repoPath: string): Promise<boolean> {
  try {
    const st = await status(repoPath);
    // Untracked-only trees don't block a switch (git carries new files over),
    // so only tracked modifications — staged or unstaged — warrant the prompt.
    return st.entries.some(
      (e) => !(e.index_status === "?" && e.worktree_status === "?"),
    );
  } catch {
    // If status can't be read, assume clean and let the checkout itself
    // surface any real error rather than blocking on a false positive.
    return false;
  }
}

/// Refresh everything a branch switch can affect: the active view (graph /
/// status + branch chip), the refs sidebar, the stash list, and any pending
/// operation banner.
async function refreshAfterCheckout(): Promise<void> {
  await refreshActiveView();
  void loadCurrentBranch();
  void loadStashes();
  void loadPendingOp();
  void reloadBranchesFor(appState.changesRepoIdx);
}

/// Run a checkout with the chosen strategy and refresh on success. Throws on
/// failure so the caller (dialog) can surface an inline error and stay open.
/// When `ffTo` is set (a remote ref), the local branch is fast-forwarded to it
/// after the switch — used for remote-branch double-clicks so a behind local
/// catches up. A fast-forward failure (diverged) is surfaced but doesn't undo
/// the completed switch.
export async function runCheckout(
  repoPath: string,
  target: string,
  strategy: CheckoutStrategy,
  ffTo?: string,
): Promise<void> {
  if (strategy === "stash") await stashCheckout(repoPath, target);
  else if (strategy === "discard") await forceCheckout(repoPath, target);
  else await checkout(repoPath, target);
  if (ffTo) {
    try {
      await fastForward(repoPath, ffTo);
    } catch (e) {
      appState.error = `Switched to ${target}, but couldn't fast-forward to ${ffTo}: ${e}`;
    }
  }
  await refreshAfterCheckout();
}

/// Entry point for every checkout affordance. On a clean tree it switches
/// immediately; on a dirty tree it opens the CheckoutDialog to let the user
/// pick stash / bring / discard. `ffTo` (a remote ref) fast-forwards the local
/// to the remote after the switch.
export async function requestCheckout(
  repoPath: string,
  target: string,
  ffTo?: string,
): Promise<void> {
  if (await isDirty(repoPath)) {
    appState.checkoutPrompt = { repoPath, target, ffTo };
    return;
  }
  try {
    await runCheckout(repoPath, target, "bring", ffTo);
  } catch (e) {
    appState.error = String(e);
    void loadPendingOp();
  }
}
