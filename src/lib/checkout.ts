import { appState } from "./store.svelte";
import { status, checkout, forceCheckout, stashCheckout } from "./git";
import {
  refreshActiveView,
  loadCurrentBranch,
  loadStashes,
  loadPendingOp,
} from "./sourceControl";

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
}

/// Run a checkout with the chosen strategy and refresh on success. Throws on
/// failure so the caller (dialog) can surface an inline error and stay open.
export async function runCheckout(
  repoPath: string,
  target: string,
  strategy: CheckoutStrategy,
): Promise<void> {
  if (strategy === "stash") await stashCheckout(repoPath, target);
  else if (strategy === "discard") await forceCheckout(repoPath, target);
  else await checkout(repoPath, target);
  await refreshAfterCheckout();
}

/// Entry point for every checkout affordance. On a clean tree it switches
/// immediately; on a dirty tree it opens the CheckoutDialog to let the user
/// pick stash / bring / discard.
export async function requestCheckout(
  repoPath: string,
  target: string,
): Promise<void> {
  if (await isDirty(repoPath)) {
    appState.checkoutPrompt = { repoPath, target };
    return;
  }
  try {
    await runCheckout(repoPath, target, "bring");
  } catch (e) {
    appState.error = String(e);
    void loadPendingOp();
  }
}
