<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { popHistory } from "$lib/history";

  function currentLabel(): string {
    if (appState.compareMode === "worktree") return "working tree";
    const sep = appState.mode === "two-dot" ? ".." : "...";
    return `${appState.startBranch}${sep}${appState.targetBranch}`;
  }

  function previousLabel(): string | null {
    const prev = appState.history[appState.history.length - 1];
    if (!prev) return null;
    if (prev.compareMode === "worktree") return "working tree";
    const sep = prev.mode === "two-dot" ? ".." : "...";
    return `${prev.startBranch}${sep}${prev.targetBranch}`;
  }
</script>

{#if appState.history.length > 0}
  <div class="breadcrumb">
    <button type="button" class="back" onclick={popHistory} title="Back (Esc)">
      ← Back
    </button>
    <span>Viewing <code>{currentLabel()}</code></span>
    {#if previousLabel()}
      <span class="prev">(was: <code>{previousLabel()}</code>)</span>
    {/if}
    <span class="depth">depth {appState.history.length}</span>
  </div>
{/if}

<style>
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    font-size: 0.85em;
  }
  .back {
    padding: 2px 10px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
  }
  .back:hover {
    background: var(--hover);
  }
  code {
    font-family: var(--mono);
    font-size: 0.95em;
    padding: 1px 4px;
    background: var(--input-bg);
    border-radius: 3px;
  }
  .prev {
    opacity: 0.6;
  }
  .depth {
    margin-left: auto;
    opacity: 0.5;
    font-size: 0.85em;
  }
</style>
