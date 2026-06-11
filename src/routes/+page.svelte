<script lang="ts">
  import { onMount } from "svelte";
  import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
  import { gotoLine, openSearchPanel } from "@codemirror/search";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import InputBar from "$lib/ui/InputBar.svelte";
  import FileList from "$lib/ui/FileList.svelte";
  import CommitList from "$lib/ui/CommitList.svelte";
  import ChangesList from "$lib/ui/ChangesList.svelte";
  import CommitBox from "$lib/ui/CommitBox.svelte";
  import RepoTabs from "$lib/ui/RepoTabs.svelte";
  import RefsSidebar from "$lib/ui/RefsSidebar.svelte";
  import ConflictBanner from "$lib/ui/ConflictBanner.svelte";
  import ConflictView from "$lib/ui/ConflictView.svelte";
  import CheckoutDialog from "$lib/ui/CheckoutDialog.svelte";
  import CommandPalette from "$lib/ui/CommandPalette.svelte";
  import Timelapse from "$lib/ui/Timelapse.svelte";
  import DiffView from "$lib/ui/DiffView.svelte";
  import BlameView from "$lib/ui/BlameView.svelte";
  import Breadcrumb from "$lib/ui/Breadcrumb.svelte";
  import TabBar from "$lib/ui/TabBar.svelte";
  import TitleBar from "$lib/ui/TitleBar.svelte";
  import { appState } from "$lib/store.svelte";
  import { loadState, setBlamePickerWidth } from "$lib/git";
  import { loadMainRepo } from "$lib/workspace";
  import { cycleAppMode } from "$lib/compare";
  import { setHistoryRepo, enterGraphView } from "$lib/commitHistory";
  import {
    enterChangesMode,
    isPathConflicted,
    loadStatus,
    refreshActiveView,
    setChangesRepo,
  } from "$lib/sourceControl";
  import { popHistory, redoHistory } from "$lib/history";
  import { exitFocus } from "$lib/focus";
  import { cycleTab, selectTab } from "$lib/tabs";
  import { applyTheme, subscribeSystemTheme } from "$lib/theme";
  import { adjustFontSize, applyFontSize, resetFontSize } from "$lib/font";
  import { getActiveDiffView } from "$lib/diff/activeView";
  import { preheatHighlighter } from "$lib/diff/shiki";
  import { checkForUpdate } from "$lib/updater";

  let pendingUpdate: Awaited<ReturnType<typeof checkForUpdate>> = null;

  // Drag-resize the compare file picker, mirroring BlameView. Shares the same
  // persisted width (`blamePickerWidth`) so the sidebar stays a consistent
  // width across blame / branch / worktree modes. Bounds match the backend clamp.
  const PICKER_MIN = 200;
  const PICKER_MAX = 600;
  let bodyEl: HTMLDivElement;
  let resizing = $state(false);
  function onResizeStart(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = true;
    const rect = bodyEl.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const next = Math.round(ev.clientX - rect.left);
      appState.blamePickerWidth = Math.min(
        PICKER_MAX,
        Math.max(PICKER_MIN, next),
      );
    };
    const onUp = () => {
      resizing = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setBlamePickerWidth(appState.blamePickerWidth).catch(() => {});
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Drag-resize the horizontal split between the commit list (top) and the
  // commit's file list (bottom) in history mode. Session-only — the fraction
  // isn't persisted. Clamped so neither pane collapses entirely.
  // Graph mode: drag the boundary between the wide graph and the right-hand
  // commit-detail panel (files + diff). Adjusts its width; session-only.
  let graphRowEl = $state<HTMLDivElement | null>(null);
  function onGraphDetailResize(e: PointerEvent) {
    if (e.button !== 0 || !graphRowEl) return;
    e.preventDefault();
    const rect = graphRowEl.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      appState.graphDetailWidth = Math.min(
        rect.width - 240,
        Math.max(280, ev.clientX - rect.left),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  onMount(async () => {
    try {
      const s = await loadState();
      appState.recentRepos = s.recent_repos;
      appState.theme = s.theme;
      appState.fontSize = s.font_size;
      // Only branch compare remains (Working Tree folded into Changes).
      appState.compareMode = "branch";
      appState.manualReposByMain = s.manual_repos_by_main ?? {};
      appState.workspaceLayout = s.workspace_layout ?? "unified";
      appState.blamePickerWidth = s.blame_picker_width ?? 300;
      appState.fileViewMode = s.file_view_mode ?? "tree";
      appState.graphRowHeight = s.graph_row_height ?? 40;
      appState.parseUnrealAssets = s.parse_unreal_assets ?? true;
      appState.uassetguiPath = s.uassetgui_path ?? null;
      appState.ueVersionByRepo = s.ue_version_by_repo ?? {};
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

  // Auto-refresh the active source-control view when the window regains focus
  // after a real blur — the user may have edited files or run git (e.g. an
  // external checkout) in another window. Covers Changes (status) and Graph
  // (branch chip + commits + refs). Silent. WebView2 on Windows emits
  // blur/focus *pairs* during window drag/resize (<100ms); a 500ms threshold
  // ignores those and only reacts to real switches.
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
        if (!appState.repoPath) return;
        if (appState.appMode === "changes" || appState.appMode === "history") {
          void refreshActiveView();
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
    // Ctrl/Cmd+Shift+P toggles the command palette — works whether it's open
    // (so the same chord closes it) or closed.
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      e.key.toLowerCase() === "p"
    ) {
      appState.paletteOpen = !appState.paletteOpen;
      e.preventDefault();
      return;
    }

    // Modal surfaces own the keyboard — suppress every other global shortcut
    // while one is open (each handles its own Esc).
    if (appState.checkoutPrompt || appState.paletteOpen) return;

    const t = e.target as HTMLElement | null;
    const tag = t?.tagName?.toLowerCase();

    // Ctrl+Shift+W cycles app modes (Changes → Compare → Blame)
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

    // Ctrl+B toggles the refs sidebar, regardless of focus.
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      e.key.toLowerCase() === "b"
    ) {
      appState.sidebarOpen = !appState.sidebarOpen;
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

    // F5 or Ctrl+R refreshes the Changes status.
    const isRefresh =
      e.key === "F5" ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "r");
    if (isRefresh && appState.appMode === "changes") {
      void loadStatus();
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
      if (appState.wipReturn && appState.appMode === "changes") {
        // Came from the graph's WIP node into Changes — go back to the graph,
        // and arm forward so X2 returns here.
        void enterGraphView();
        appState.wipForward = true;
        e.preventDefault();
      } else if (appState.history.length > 0) {
        popHistory();
        e.preventDefault();
      } else if (appState.activeRepoIdx !== null) {
        exitFocus();
        e.preventDefault();
      }
    } else if (e.button === 4) {
      if (appState.wipForward && appState.appMode === "history") {
        // Forward from the graph back into the WIP changes view.
        void enterChangesMode();
        appState.wipReturn = true;
        e.preventDefault();
      } else if (appState.forwardHistory.length > 0) {
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
  <ConflictBanner />
  <CheckoutDialog />
  <CommandPalette />
  <Timelapse />
  {#if appState.appMode === "compare" && appState.workspaceLayout === "tabs" && appState.repos.length > 0}
    <TabBar />
  {/if}
  {#if appState.repos.length > 1 && appState.appMode === "history"}
    <RepoTabs value={appState.historyRepoIdx} onselect={setHistoryRepo} />
  {:else if appState.repos.length > 1 && appState.appMode === "changes"}
    <RepoTabs value={appState.changesRepoIdx} onselect={setChangesRepo} />
  {/if}
  <div class="workarea">
    {#if appState.sidebarOpen}
      <RefsSidebar />
    {/if}
    <div
      class="body"
      class:resizing
      bind:this={bodyEl}
      style="--picker-width: {appState.blamePickerWidth}px;"
    >
    {#snippet diffPane()}
      <main class="diff">
        {#if appState.selectedFile}
          {@const conflicted =
            appState.appMode === "changes" &&
            isPathConflicted(appState.selectedFile.path)}
          <header>
            <span class="badge" data-status={appState.selectedFile.status}>
              {conflicted ? "conflict" : appState.selectedFile.status}
            </span>
            <span class="path">{appState.selectedFile.path}</span>
            {#if appState.selectedFile.old_path}
              <span class="from">(from {appState.selectedFile.old_path})</span>
            {/if}
          </header>
          {#if conflicted}
            <ConflictView />
          {:else}
            <DiffView />
          {/if}
        {:else if appState.loadingRepo}
          <div class="placeholder">Opening repository…</div>
        {:else if appState.loadingFiles}
          <div class="placeholder">Scanning changed files…</div>
        {:else if appState.appMode === "history"}
          <div class="placeholder">Select a commit to view its changes.</div>
        {:else if appState.appMode === "changes"}
          <div class="placeholder">
            {appState.loadingStatus
              ? "Loading changes…"
              : "No changes — working tree is clean."}
          </div>
        {:else}
          <div class="placeholder">
            Select a repository and two refs to compare.
          </div>
        {/if}
      </main>
    {/snippet}

    {#if appState.appMode === "blame"}
      <BlameView />
    {:else if appState.appMode === "changes"}
      <div class="changes-col">
        <div class="changes-scroll"><ChangesList /></div>
        <CommitBox />
      </div>
      <div
        class="picker-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize change list"
        onpointerdown={onResizeStart}
      ></div>
      {@render diffPane()}
    {:else if appState.appMode === "history"}
      <div class="graph-row" bind:this={graphRowEl}>
        <div
          class="graph-detail"
          style="--gd-w: {appState.graphDetailWidth}px;"
        >
          <div class="gd-files"><FileList /></div>
          {@render diffPane()}
        </div>
        <div
          class="graph-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize commit detail"
          onpointerdown={onGraphDetailResize}
        ></div>
        <div class="graph-main"><CommitList /></div>
      </div>
    {:else}
      <FileList />
      <div
        class="picker-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file list"
        onpointerdown={onResizeStart}
      ></div>
      {@render diffPane()}
    {/if}
    </div>
  </div>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .workarea {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .body {
    position: relative;
    display: grid;
    /* File picker column is user-resizable; the drag handle is absolutely
       positioned at the column boundary (see .picker-resizer). */
    grid-template-columns: var(--picker-width, 300px) 1fr;
    /* Bound the single row to the container height (not auto-grow to the file
       list's content), so each column can scroll internally. */
    grid-template-rows: minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .body.resizing {
    cursor: col-resize;
    user-select: none;
  }
  .picker-resizer {
    position: absolute;
    top: 0;
    left: var(--picker-width, 300px);
    width: 7px;
    height: 100%;
    transform: translateX(-3px);
    cursor: col-resize;
    z-index: 5;
    background: transparent;
  }
  .picker-resizer::after {
    content: "";
    position: absolute;
    top: 0;
    left: 3px;
    width: 1px;
    height: 100%;
    background: transparent;
    transition: background 0.1s ease;
  }
  .picker-resizer:hover::after,
  .body.resizing .picker-resizer::after {
    background: var(--accent, #4a9eff);
  }
  /* Changes mode: the left grid column stacks the scrollable change lists on
     top of a fixed commit box at the bottom. */
  .changes-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .changes-scroll {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }
  /* Graph mode: the commit graph is the wide primary area; the selected
     commit's files + diff live in a resizable detail panel on the right. */
  .graph-row {
    grid-column: 1 / -1;
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .graph-main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .graph-resizer {
    flex: 0 0 7px;
    margin: 0 -3px;
    z-index: 5;
    cursor: col-resize;
    background: transparent;
    position: relative;
  }
  .graph-resizer::after {
    content: "";
    position: absolute;
    left: 3px;
    top: 0;
    width: 1px;
    height: 100%;
    background: var(--border);
    transition: background 0.1s ease;
  }
  .graph-resizer:hover::after {
    background: var(--accent);
  }
  .graph-detail {
    flex: 0 0 var(--gd-w, 460px);
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--border);
  }
  .gd-files {
    flex: 0 0 38%;
    min-height: 0;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
  }
  .diff {
    display: flex;
    flex-direction: column;
    flex: 1;
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
