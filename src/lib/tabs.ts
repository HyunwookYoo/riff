import { appState } from "./store.svelte";
import { getActiveDiffView } from "./diff/activeView";

/**
 * Switch to the tab at `idx` (§14). Snapshots the outgoing tab's selected
 * file + scroll position into `tabMemory`, then restores the incoming tab's
 * saved file (or falls back to the first file in that repo). No-op when the
 * tab is already active.
 *
 * Used by `TabBar` clicks and by the Ctrl+Tab / Ctrl+1..9 keybindings —
 * keeping one implementation so both entry points behave identically.
 */
export function selectTab(idx: number): void {
  const prev = appState.activeRepoIdx;
  if (prev === idx) return;
  if (idx < 0 || idx >= appState.repos.length) return;

  if (prev !== null) {
    const sel = appState.selectedFile;
    const view = getActiveDiffView();
    const scrollPos = view?.scrollDOM.scrollTop;
    const next = new Map(appState.tabMemory);
    next.set(prev, {
      filePath: sel?.path ?? null,
      scrollPos: typeof scrollPos === "number" ? scrollPos : undefined,
    });
    appState.tabMemory = next;
  }

  appState.activeRepoIdx = idx;

  const mem = appState.tabMemory.get(idx);
  const candidates = appState.files.filter((f) => (f.repoIdx ?? 0) === idx);
  const restored = mem?.filePath
    ? candidates.find((f) => f.path === mem.filePath)
    : undefined;
  appState.selectedFile = restored ?? candidates[0] ?? null;
}

/**
 * Cycle to the next (or previous, when `delta = -1`) tab. Wraps around the
 * workspace. Used by Ctrl+Tab / Ctrl+Shift+Tab.
 */
export function cycleTab(delta: 1 | -1): void {
  const n = appState.repos.length;
  if (n === 0) return;
  const cur = appState.activeRepoIdx ?? 0;
  selectTab((cur + delta + n) % n);
}
