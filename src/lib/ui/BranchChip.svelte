<script lang="ts">
  import { appState } from "$lib/store.svelte";

  // Current branch of the source-control repo. Click toggles the Branches
  // sidebar where you switch / create / manage branches.
  const branch = $derived(appState.currentBranch);
  const ahead = $derived(appState.currentAhead);
  const behind = $derived(appState.currentBehind);
</script>

{#if appState.repoPath}
  <button
    type="button"
    class="branch-chip"
    class:active={appState.sidebarOpen}
    title="Current branch — click for branches (Ctrl+B)"
    onclick={() => (appState.sidebarOpen = !appState.sidebarOpen)}
  >
    <span class="glyph" aria-hidden="true">⎇</span>
    <span class="bname">{branch ?? "detached"}</span>
    {#if ahead || behind}
      <span class="ab">
        {#if behind}↓{behind}{/if}{#if ahead}↑{ahead}{/if}
      </span>
    {/if}
  </button>
{/if}

<style>
  .branch-chip {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 220px;
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.82em;
  }
  .branch-chip:hover,
  .branch-chip.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .glyph {
    opacity: 0.7;
  }
  .bname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-weight: 600;
  }
  .ab {
    flex-shrink: 0;
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
  }
</style>
