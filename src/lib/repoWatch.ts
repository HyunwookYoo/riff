import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { appState } from "./store.svelte";
import { loadPendingOp, loadStashes, refreshActiveView } from "./sourceControl";

// Backend `repo-changed` events (already debounced ~300ms in Rust) drive the
// active-view refresh. A short UI-side coalesce collapses the handful that can
// arrive together (main + manual repos) into one refresh pass.
let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(): void {
  // An in-app git op (rebase/merge/pull/…) is driving the repo and will refresh
  // the view itself when it finishes or stops; ignore the churn it makes
  // meanwhile so the UI doesn't update on every commit a rebase replays.
  if (appState.gitOpDepth > 0) return;
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    if (!appState.repoPath) return;
    // An op may have started after this was scheduled — let it own the refresh.
    if (appState.gitOpDepth > 0) return;
    // refreshActiveView reloads status (Changes) or branch chip + graph
    // (History) and nudges the refs sidebar; pending-op + stashes cover the
    // conflict banner and stash list.
    void refreshActiveView();
    void loadPendingOp();
    void loadStashes();
  }, 120);
}

/// Subscribe to the backend filesystem watcher. Real repo changes — external
/// git ops, file edits, in-app or not — refresh the active view live, so we no
/// longer rescan on every window refocus. Returns an unlisten for teardown.
export function initRepoWatch(): Promise<UnlistenFn> {
  return listen("repo-changed", () => scheduleRefresh());
}
