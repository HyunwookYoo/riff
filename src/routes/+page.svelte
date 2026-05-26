<script lang="ts">
  import { onMount } from "svelte";
  import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
  import { gotoLine, openSearchPanel } from "@codemirror/search";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import InputBar from "$lib/ui/InputBar.svelte";
  import FileList from "$lib/ui/FileList.svelte";
  import DiffView from "$lib/ui/DiffView.svelte";
  import BlameView from "$lib/ui/BlameView.svelte";
  import Breadcrumb from "$lib/ui/Breadcrumb.svelte";
  import TabBar from "$lib/ui/TabBar.svelte";
  import TitleBar from "$lib/ui/TitleBar.svelte";
  import { appState } from "$lib/store.svelte";
  import { loadState } from "$lib/git";
  import { loadMainRepo } from "$lib/workspace";
  import { compare, cycleAppMode } from "$lib/compare";
  import { popHistory, redoHistory } from "$lib/history";
  import { exitFocus } from "$lib/focus";
  import { cycleTab, selectTab } from "$lib/tabs";
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
      appState.manualReposByMain = s.manual_repos_by_main ?? {};
      appState.workspaceLayout = s.workspace_layout ?? "unified";
    } catch {
      // First-run / corrupt state: keep defaults silently.
    }
    applyTheme();
    subscribeSystemTheme();
    applyFontSize();
    preheatHighlighter();

    // Auto-restore the last opened main repo. Silent — if the folder was
    // moved/deleted since last session, we don't want to greet the user
    // with an error banner; they can pick a different repo from the chip.
    const lastRepo = appState.recentRepos[0];
    if (lastRepo) {
      void loadMainRepo(lastRepo, { silent: true });
    }

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
  //
  // Only refresh when the window was actually blurred for a meaningful time.
  // WebView2 on Windows emits blur/focus *pairs* during window drag/resize —
  // they flip in well under 100ms — and we don't want a real worktree scan
  // running for those. A 500ms threshold cleanly separates real Alt-Tab/click-
  // -away switches (typically 500ms+) from drag-induced noise.
  onMount(() => {
    let unlisten: (() => void) | undefined;
    let blurredAt = 0;
    const MIN_BLUR_MS = 500;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          if (blurredAt === 0) blurredAt = Date.now();
          return;
        }
        if (blurredAt === 0) return;
        const duration = Date.now() - blurredAt;
        blurredAt = 0;
        if (duration < MIN_BLUR_MS) return;
        if (
          appState.appMode !== "compare" ||
          appState.compareMode !== "worktree" ||
          !appState.repoPath ||
          appState.loadingFiles ||
          appState.loadingRepo
        ) {
          return;
        }
        void compare({ silent: true });
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
    // Multi-root (§13.3 #14): j/k skips collapsed repo groups. Path alone
    // is ambiguous now — same path can live in main + a submodule — so we
    // match selected by (repoIdx, path) and filter the candidate list to
    // visible files.
    const visible = appState.files.filter(
      (f) => !appState.collapsedRepos.has(f.repoIdx ?? 0),
    );
    if (visible.length === 0) return;
    const sel = appState.selectedFile;
    const cur = sel
      ? visible.findIndex(
          (f) => f.path === sel.path && (f.repoIdx ?? 0) === (sel.repoIdx ?? 0),
        )
      : -1;
    const next = cur < 0 ? 0 : (cur + delta + visible.length) % visible.length;
    appState.selectedFile = visible[next];
  }

  function onKeyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName?.toLowerCase();

    // Ctrl+Shift+W cycles app modes (branch compare → worktree compare → blame)
    // regardless of focus, so the user can switch even while a ref input has
    // the cursor.
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      e.key.toLowerCase() === "w"
    ) {
      cycleAppMode();
      e.preventDefault();
      return;
    }

    // §14.6 #21: Tab navigation — Ctrl+Tab next, Ctrl+Shift+Tab previous,
    // Ctrl+1..9 jump to that tab. Active only in Tabs layout while comparing.
    // Fires before the form-control yield so users can switch tabs while
    // focus is on a BranchPicker input. preventDefault is required to stop
    // WebView2's default Ctrl+Tab behavior.
    if (
      appState.workspaceLayout === "tabs" &&
      appState.appMode === "compare" &&
      appState.repos.length > 0 &&
      (e.ctrlKey || e.metaKey)
    ) {
      if (e.key === "Tab") {
        cycleTab(e.shiftKey ? -1 : 1);
        e.preventDefault();
        return;
      }
      if (!e.shiftKey && e.key >= "1" && e.key <= "9") {
        const idx = Number(e.key) - 1;
        if (idx < appState.repos.length) {
          selectTab(idx);
          e.preventDefault();
          return;
        }
      }
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

    // Ctrl+G — opens CodeMirror's goto-line panel on the active editor.
    // Works regardless of focus so the user can jump even while typing in
    // the file picker.
    const isCtrlG = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g";
    if (isCtrlG) {
      const v = getActiveDiffView();
      if (v) {
        gotoLine(v);
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

    // Esc backs out of a commit drill-in, or exits Focus mode (§13.3 #15
    // "Esc로 해제") when no history is pending. Yields to CodeMirror's
    // search panel: if it consumed Esc to close itself, defaultPrevented
    // is set and we leave both state machines alone.
    if (e.key === "Escape" && !e.defaultPrevented) {
      if (appState.history.length > 0) {
        popHistory();
        e.preventDefault();
      } else if (appState.activeRepoIdx !== null) {
        exitFocus();
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
      case "ArrowDown":
        moveSelection(1);
        e.preventDefault();
        break;
      case "ArrowUp":
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
    }
  }

  // Mouse X1 / X2 buttons (commonly labeled Back / Forward on browsers and
  // gaming mice) act as drill-in back / forward. Fired on `mousedown` so
  // they win over WebView2's default browser-back behavior — without
  // preventDefault, Edge WebView2 may reload the dev server route.
  function onMouseDown(e: MouseEvent) {
    if (e.button === 3) {
      if (appState.history.length > 0) {
        popHistory();
        e.preventDefault();
      } else if (appState.activeRepoIdx !== null) {
        exitFocus();
        e.preventDefault();
      }
    } else if (e.button === 4) {
      if (appState.forwardHistory.length > 0) {
        redoHistory();
        e.preventDefault();
      }
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} onmousedown={onMouseDown} />

<div class="app">
  <TitleBar />
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
  {#if appState.appMode === "compare" && appState.workspaceLayout === "tabs" && appState.repos.length > 0}
    <TabBar />
  {/if}
  <div class="body">
    {#if appState.appMode === "blame"}
      <BlameView />
    {:else}
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
    {/if}
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
