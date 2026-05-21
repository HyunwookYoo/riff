<script lang="ts">
  import { onMount } from "svelte";
  import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
  import { openSearchPanel } from "@codemirror/search";
  import InputBar from "$lib/ui/InputBar.svelte";
  import FileList from "$lib/ui/FileList.svelte";
  import DiffView from "$lib/ui/DiffView.svelte";
  import { appState } from "$lib/store.svelte";
  import { loadState } from "$lib/git";
  import { applyTheme, subscribeSystemTheme } from "$lib/theme";
  import { getActiveDiffView } from "$lib/diff/activeView";

  onMount(async () => {
    try {
      const s = await loadState();
      appState.recentRepos = s.recent_repos;
      appState.theme = s.theme;
    } catch {
      // First-run / corrupt state: keep defaults silently.
    }
    applyTheme();
    subscribeSystemTheme();
  });

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

    if (e.ctrlKey || e.metaKey || e.altKey) return;

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
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="app">
  <InputBar />
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
      {:else if appState.loading}
        <div class="placeholder">Loading…</div>
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
</style>
