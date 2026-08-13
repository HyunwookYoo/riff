import { appState } from "./store.svelte";
import {
  status,
  checkout,
  forceCheckout,
  stashCheckout,
  fastForward,
  fetch as fetchRemotes,
} from "./git";
import {
  refreshActiveView,
  loadCurrentBranch,
  loadStashes,
  loadPendingOp,
} from "./workingCopy";
import { reloadBranchesFor } from "./workspace";
import { offerRecovery } from "./recovery";

/// How to handle uncommitted changes when switching branches:
/// - `bring`: carry them over (`git checkout`) — fails if they conflict.
/// - `stash`: stash, switch, then reapply (`git stash pop`).
/// - `discard`: throw away tracked changes (`git checkout -f`). Destructive.
export type CheckoutStrategy = "bring" | "stash" | "discard";

/// True when the working tree has tracked modifications (staged or unstaged)
/// that would block a clean switch or rebase. Untracked-only trees return false
/// (git carries new files across both operations).
export async function isDirty(repoPath: string): Promise<boolean> {
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
/// When `ffTo` is set (a remote ref), this is a real "pull": the remote is
/// fetched and the just-switched local branch is fast-forwarded up to it —
/// used for remote-branch double-clicks so a behind local catches up to the
/// server. A fetch (offline) or fast-forward (diverged) failure is surfaced
/// but doesn't undo the completed switch.
export async function runCheckout(
  repoPath: string,
  target: string,
  strategy: CheckoutStrategy,
  ffTo?: string,
): Promise<void> {
  appState.error = null;
  // Progress banner + watcher suppression while the switch runs — and, for a
  // remote badge, the fetch + fast-forward, which can take a while over the
  // network. "Pulling…" when we're catching up to a remote, else "Checking
  // out…".
  appState.beginGitOp(ffTo ? "Pulling…" : "Checking out…");
  try {
    if (strategy === "stash") await stashCheckout(repoPath, target);
    else if (strategy === "discard") await forceCheckout(repoPath, target);
    else await checkout(repoPath, target);
    if (ffTo) {
      // Fetch first so the remote-tracking ref reflects the server, then
      // fast-forward — otherwise we'd only ever catch up to a stale local copy.
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

/// Entry point for every checkout affordance. On a clean tree it switches
/// immediately; on a dirty tree it opens the CheckoutDialog to let the user
/// pick stash / bring / discard. `ffTo` (a remote ref) fetches + fast-forwards
/// (pulls) the local to the remote after the switch.
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
    const raw = String(e);
    // Always surface the raw message: on an unknown failure it's the only
    // feedback, and when the recovery dialog opens it sits on top with this
    // banner waiting underneath — so Cancel reveals it.
    appState.error = raw;
    const handled = offerRecovery(
      raw,
      "checkout",
      `Switch to ${target}`,
      true, // discard is free for checkout (force_checkout exists)
      (strategy) =>
        runCheckout(repoPath, target, strategy === "discard" ? "discard" : "stash", ffTo),
    );
    if (!handled) void loadPendingOp();
  }
}
