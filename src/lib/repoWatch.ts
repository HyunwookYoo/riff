import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { appState } from "./store.svelte";
import { bumpEpoch } from "./inflight";
import { loadPendingOp, refreshActiveView } from "./workingCopy";

// Backend `repo-changed` events (already debounced ~300ms in Rust) drive the
// active-view refresh. A short UI-side coalesce collapses the handful that can
// arrive together (main + manual repos) into one refresh pass.
let timer: ReturnType<typeof setTimeout> | null = null;
// A pass spawns `git status` against the whole worktree, and git spawns another
// one inside every submodule. On a large repo that takes tens of seconds — far
// longer than the gap between events under sustained churn, which the backend
// caps at DEBOUNCE_MAX (1.5s). Passes must therefore never overlap: otherwise
// each event starts another batch of git processes while the previous batch is
// still walking the tree, and they pile up until the disk is saturated, which
// slows status further and feeds back. Events arriving mid-pass collapse into a
// single trailing pass, so at most one pass runs and no change is missed.
let running = false;
let pending = false;

function scheduleRefresh(): void {
  // An in-app git op (rebase/merge/pull/…) is driving the repo and will refresh
  // the view itself when it finishes or stops; ignore the churn it makes
  // meanwhile so the UI doesn't update on every commit a rebase replays.
  if (appState.gitOpDepth > 0) return;
  if (running) {
    pending = true;
    return;
  }
  if (timer !== null) return;
  timer = setTimeout(() => void runRefresh(), 120);
}

async function runRefresh(): Promise<void> {
  timer = null;
  // Anything that arrived before this pass started is covered by it.
  pending = false;
  if (!appState.repoPath) return;
  // An op may have started after this was scheduled — let it own the refresh.
  if (appState.gitOpDepth > 0) return;
  running = true;
  try {
    // refreshActiveView reloads status (Changes) or branch chip + graph
    // (History) and nudges the refs sidebar; pending-op covers the conflict
    // banner.
    await Promise.all([refreshActiveView(), loadPendingOp()]);
  } finally {
    running = false;
    if (pending) scheduleRefresh();
  }
}

/// Subscribe to the backend filesystem watcher. Real repo changes — external
/// git ops, file edits, in-app or not — refresh the active view live, so we no
/// longer rescan on every window refocus. Returns an unlisten for teardown.
export function initRepoWatch(): Promise<UnlistenFn> {
  return listen("repo-changed", () => {
    // The repo moved under us: reads in flight describe the old state, so no
    // later caller may be answered by one (see inflight.ts).
    bumpEpoch();
    scheduleRefresh();
  });
}
