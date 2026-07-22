import { appState } from "./store.svelte";
import {
  enterChangesMode,
  changesRepoPath,
  doFetch,
  doPull,
  doPush,
  doStashSave,
  undoLastCommit,
} from "./sourceControl";
import { enterGraphView, restoreCompareContext } from "./commitHistory";
import { requestCheckout } from "./checkout";
import { chooseTheme } from "./theme";
import { adjustFontSize, resetFontSize } from "./font";

/// A single palette entry. `run` performs the action; `title` is what the user
/// searches and sees, `category` groups/labels it.
export interface Command {
  id: string;
  title: string;
  category: string;
  run: () => void | Promise<void>;
}

/// Build the command list from the current app state, so dynamic entries
/// (checkout a branch, pop a stash) reflect what's actually available.
export function buildCommands(): Command[] {
  const cmds: Command[] = [];

  // Navigation / view
  cmds.push(
    { id: "go.changes", title: "Go to Changes", category: "Go", run: () => void enterChangesMode() },
    { id: "go.graph", title: "Go to Graph", category: "Go", run: () => void enterGraphView() },
    {
      id: "go.compare",
      title: "Go to Branch compare",
      category: "Go",
      run: () => {
        restoreCompareContext();
        appState.appMode = "compare";
      },
    },
    {
      id: "go.blame",
      title: "Go to Blame",
      category: "Go",
      run: () => {
        if (appState.selectedFile)
          appState.blameTarget = {
            repoIdx: appState.selectedFile.repoIdx ?? 0,
            path: appState.selectedFile.path,
          };
        appState.appMode = "blame";
      },
    },
    {
      id: "view.sidebar",
      title: "Toggle refs sidebar",
      category: "View",
      run: () => {
        appState.sidebarOpen = !appState.sidebarOpen;
      },
    },
    {
      id: "view.split",
      title: "Diff: side-by-side",
      category: "View",
      run: () => {
        appState.viewMode = "side-by-side";
      },
    },
    {
      id: "view.unified",
      title: "Diff: unified",
      category: "View",
      run: () => {
        appState.viewMode = "unified";
      },
    },
    { id: "font.inc", title: "Font: increase", category: "View", run: () => void adjustFontSize(1) },
    { id: "font.dec", title: "Font: decrease", category: "View", run: () => void adjustFontSize(-1) },
    { id: "font.reset", title: "Font: reset", category: "View", run: () => void resetFontSize() },
    { id: "theme.system", title: "Theme: system", category: "Theme", run: () => chooseTheme("system") },
    { id: "theme.light", title: "Theme: light", category: "Theme", run: () => chooseTheme("light") },
    { id: "theme.dark", title: "Theme: dark", category: "Theme", run: () => chooseTheme("dark") },
  );

  // Sync
  cmds.push(
    { id: "sync.fetch", title: "Fetch", category: "Sync", run: () => void doFetch() },
    { id: "sync.pull", title: "Pull (merge)", category: "Sync", run: () => void doPull(false) },
    { id: "sync.pullRebase", title: "Pull (rebase)", category: "Sync", run: () => void doPull(true) },
    { id: "sync.push", title: "Push", category: "Sync", run: () => void doPush(false) },
  );

  // Stash — quick whole-tree save, plus the panel that lists/manages stashes.
  cmds.push(
    { id: "stash.save", title: "Stash: save changes", category: "Stash", run: () => void doStashSave() },
    { id: "stash.view", title: "View stashes", category: "Stash", run: () => { appState.stashesOpen = true; } },
  );

  // Commit history / help
  cmds.push(
    {
      id: "commit.undo",
      title: "Undo last commit",
      category: "Commit",
      run: () => void undoLastCommit(),
    },
    {
      id: "reflog.open",
      title: "Reflog / Undo history",
      category: "Commit",
      run: () => {
        appState.reflogOpen = true;
      },
    },
    {
      id: "help.shortcuts",
      title: "Keyboard shortcuts",
      category: "Help",
      run: () => {
        appState.shortcutsOpen = true;
      },
    },
  );

  // Checkout — one entry per local/remote branch in the active repo
  const repoPath = changesRepoPath();
  const branches = appState.branchesByRepoIdx[appState.changesRepoIdx] ?? [];
  for (const b of branches) {
    if (b.kind === "tag") continue;
    const isRemote = b.kind === "remote";
    const target = isRemote ? b.name.replace(/^[^/]+\//, "") : b.name;
    const ffTo = isRemote ? b.name : undefined;
    cmds.push({
      id: `checkout.${b.kind}.${b.name}`,
      title: `Checkout: ${b.name}`,
      category: "Branch",
      run: () => void requestCheckout(repoPath, target, ffTo),
    });
  }

  return cmds;
}
