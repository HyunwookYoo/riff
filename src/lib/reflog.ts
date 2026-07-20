/// Reflog recovery. The reflog is git's record of everywhere HEAD has been,
/// and the only place the SHAs of unreachable commits survive — after a hard
/// reset, a squashing rebase, an amend, or a deleted branch. The commit graph
/// only draws commits reachable from a ref, so it cannot show them; this
/// module is how riff gets back to one.
import { appState } from "./store.svelte";
import { reflog, reset } from "./git";
import { changesRepoPath, loadStatus } from "./sourceControl";
import { invalidateGraph } from "./commitHistory";
import { confirmAction } from "./dialogs";
import type { ReflogEntry } from "./types";

/// Read the recent HEAD reflog. Failures surface in the error banner and
/// yield an empty list rather than throwing into the overlay.
export async function loadReflog(): Promise<ReflogEntry[]> {
  try {
    return await reflog(changesRepoPath());
  } catch (e) {
    appState.error = String(e);
    return [];
  }
}

/// Restore HEAD to `sha` with a hard reset. Destructive — uncommitted changes
/// are lost — so it always confirms first. Returns true when the user
/// confirmed (i.e. the reset was attempted), false when they cancelled.
export async function resetToReflog(sha: string): Promise<boolean> {
  const ok = await confirmAction(
    "Reset to this point? Uncommitted changes will be lost.",
    { title: "Reset to reflog entry" },
  );
  if (!ok) return false;
  appState.error = null;
  try {
    await reset(changesRepoPath(), sha, "hard");
    invalidateGraph();
  } catch (e) {
    appState.error = String(e);
  } finally {
    await loadStatus();
  }
  return true;
}
