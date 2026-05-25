<script lang="ts">
  import { onMount } from "svelte";
  import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
  import { openSearchPanel } from "@codemirror/search";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import InputBar from "$lib/ui/InputBar.svelte";
  import FileList from "$lib/ui/FileList.svelte";
  import DiffView from "$lib/ui/DiffView.svelte";
  import Breadcrumb from "$lib/ui/Breadcrumb.svelte";
  import { appState } from "$lib/store.svelte";
  import { loadState } from "$lib/git";
  import { compare, toggleMode } from "$lib/compare";
  import { popHistory } from "$lib/history";
  import { applyTheme, subscribeSystemTheme } from "$lib/theme";
  import { adjustFontSize, applyFontSize, resetFontSize } from "$lib/font";
  import { getActiveDiffView } from "$lib/diff/activeView";
  import { preheatHighlighter } from "$lib/diff/shiki";
  import { checkForUpdate } from "$lib/updater";

  let pendingUpdate: Awaited<ReturnType<typeof checkForUpdate>> = null;

  onMount(async () => {
    try {
      const s = await loadState();
      appState.recentRepos = s.recent_repos;
      appState.theme = s.theme;
      appState.fontSize = s.font_size;
      appState.compareMode = s.compare_mode;
    } catch {
      // First-run / corrupt state: keep defaults silently.
    }
    applyTheme();
    subscribeSystemTheme();
    applyFontSize();
    preheatHighlighter();

    pendingUpdate = await checkForUpdate();
    if (pendingUpdate) {
      appState.availableUpdate = {
        version: pendingUpdate.version,
        notes: pendingUpdate.notes,
      };
    }
  });

  // Auto-refresh on window focus when viewing the working tree: the user
  // probably just came back from editing files in another window. Silent so a
  // transient git error doesn't flash an error banner.
  onMount(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (
          focused &&
          appState.compareMode === "worktree" &&
          appState.repoPath &&
          !appState.loadingFiles &&
          !appState.loadingRepo
        ) {
          void compare({ silent: true });
        }
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  });

  async function installUpdate() {
    if (!pendingUpdate || appState.updateInstalling) return;
    appState.updateInstalling = true;
    try {
      await pendingUpdate.update.downloadAndInstall();
      // App will exit / restart on success.
    } catch (e) {
      console.warn("update install failed:", e);
      appState.updateInstalling = false;
    }
  }

  function moveSelection(delta: 1 | -1) {
    if (appState.files.length === 0) return;
    const cur = appState.selectedFile
      ? appState.files.findIndex((f) => f.path === appState.selectedFile?.path)
      : -1;
    const next = cur < 0 ? 0 : (cur + delta + appState.files.length) % appState.files.length;
    appState.selectedFile = appState.files[next];
  }

  function onKeyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName?.toLowerCase();

    // Ctrl+Shift+W toggles compare mode regardless of focus, so the user can
    // flip modes even while a ref input has the cursor.
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      e.key.toLowerCase() === "w"
    ) {
      toggleMode();
      e.preventDefault();
      return;
    }

    // Always yield to form controls so typing in path/branch inputs is untouched.
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    const isCtrlF = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";
    if (isCtrlF) {
      const v = getActiveDiffView();
      if (v) {
        openSearchPanel(v);
        e.preventDefault();
      }
      return;
    }

    // F5 or Ctrl+R refreshes the working tree view.
    const isRefresh =
      e.key === "F5" ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "r");
    if (isRefresh && appState.compareMode === "worktree") {
      void compare();
      e.preventDefault();
      return;
    }

    // Esc backs out of a commit drill-in. Yields to CodeMirror's search
    // panel: if it consumed Esc to close itself, defaultPrevented is set
    // and we leave the history stack alone.
    if (e.key === "Escape" && !e.defaultPrevented) {
      if (appState.history.length > 0) {
        popHistory();
        e.preventDefault();
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + = / + / - / 0 → diff font size
      if (e.key === "=" || e.key === "+") {
        void adjustFontSize(1);
        e.preventDefault();
        return;
      }
      if (e.key === "-") {
        void adjustFontSize(-1);
        e.preventDefault();
        return;
      }
      if (e.key === "0") {
        void resetFontSize();
        e.preventDefault();
        return;
      }
      return;
    }

    if (e.altKey) return;

    switch (e.key) {
      case "j":
        moveSelection(1);
        e.preventDefault();
        break;
      case "k":
        moveSelection(-1);
        e.preventDefault();
        break;
      case "n":
      case "p": {
        const v = getActiveDiffView();
        if (v) {
          (e.key === "n" ? goToNextChunk : goToPreviousChunk)(v);
          e.preventDefault();
        }
        break;
      }
      case "b":
        appState.blameMode = !appState.blameMode;
        e.preventDefault();
        break;
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="app">
  <InputBar />
  <Breadcrumb />
  {#if appState.availableUpdate}
    <div class="update-banner">
      <span>
        Update available: v{appState.availableUpdate.version}
      </span>
      <button
        class="primary"
        onclick={installUpdate}
        disabled={appState.updateInstalling}
      >
        {appState.updateInstalling ? "Installing…" : "Install and restart"}
      </button>
      <button onclick={() => (appState.availableUpdate = null)}>
        Later
      </button>
    </div>
  {/if}
  <div class="body">
    <FileList />
    <main class="diff">
      {#if appState.selectedFile}
        <header>
          <span class="badge" data-status={appState.selectedFile.status}>
            {appState.selectedFile.status}
          </span>
          <span class="path">{appState.selectedFile.path}</span>
          {#if appState.selectedFile.old_path}
            <span class="from">(from {appState.selectedFile.old_path})</span>
          {/if}
        </header>
        <DiffView />
      {:else if appState.loadingRepo}
        <div class="placeholder">Opening repository…</div>
      {:else if appState.loadingFiles}
        <div class="placeholder">Scanning changed files…</div>
      {:else}
        <div class="placeholder">
          Select a repository and two refs to compare.
        </div>
      {/if}
    </main>
  </div>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .body {
    display: grid;
    grid-template-columns: 300px 1fr;
    flex: 1;
    min-height: 0;
  }
  .diff {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .diff header {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 0.85em;
  }
  .diff .badge {
    font-size: 0.7em;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--hover);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .diff .from {
    opacity: 0.5;
    font-size: 0.85em;
  }
  .placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 0.9em;
  }
  .update-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--info-bg);
    color: var(--info-fg);
    border-bottom: 1px solid var(--border);
    font-size: 0.9em;
  }
  .update-banner span {
    flex: 1;
  }
  .update-banner button {
    font-size: 0.85em;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: var(--fg);
    cursor: pointer;
  }
  .update-banner button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .update-banner button:disabled {
    cursor: default;
    opacity: 0.6;
  }
</style>
