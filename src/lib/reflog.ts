/// Reflog recovery. The reflog is git's record of everywhere HEAD has been,
/// and the only place the SHAs of unreachable commits survive — after a hard
/// reset, a squashing rebase, an amend, or a deleted branch. The commit graph
/// only draws commits reachable from a ref, so it cannot show them; this
/// module lists them so the overlay's "create branch here" can point a new
/// ref at one.
import { appState } from "./store.svelte";
import { reflog } from "./git";
import { changesRepoPath } from "./workingCopy";
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
