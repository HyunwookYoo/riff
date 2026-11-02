<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { popHistory } from "$lib/history";
  import { showToast } from "./toast";

  // The toolbar's second row in the commit view, in place of the base /
  // compare pickers: the one place the commit's SHA is shown.
  const view = $derived(appState.commitView);
  const repo = $derived.by(() => {
    if (!view || appState.repos.length < 2) return null;
    const r = appState.repos[view.repoIdx];
    return r && r.kind !== "main" ? r : null;
  });

  function copySha() {
    if (!view) return;
    void navigator.clipboard.writeText(view.target);
    showToast(`Copied ${view.target}`);
  }
</script>

{#if view}
  <button type="button" class="back" onclick={popHistory} title="Back (Esc)">← Back</button>
  <span class="label">Commit</span>
  <button type="button" class="sha" onclick={copySha} title="Copy SHA">
    {view.target.slice(0, 8)} ⧉
  </button>
  {#if repo}
    <span class="repo" title={repo.path}>{repo.displayName}</span>
  {/if}
  {#if view.from}
    <span class="from">from blame of <code>{view.from.path}</code></span>
  {/if}
{/if}

<style>
  .back,
  .sha {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    padding: 3px 10px;
    font-size: 0.9em;
  }
  .back:hover,
  .sha:hover {
    background: var(--hover);
  }
  .sha {
    font-family: var(--mono);
  }
  .label,
  .from {
    color: var(--muted);
    font-size: 0.9em;
  }
  .repo {
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .from {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  code {
    font-family: var(--mono);
    color: var(--fg);
  }
</style>
