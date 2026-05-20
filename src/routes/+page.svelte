<script lang="ts">
  import InputBar from "$lib/ui/InputBar.svelte";
  import FileList from "$lib/ui/FileList.svelte";
  import { appState } from "$lib/store.svelte";
</script>

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
        <div class="placeholder">
          Diff rendering arrives in Sprint 2.
        </div>
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
