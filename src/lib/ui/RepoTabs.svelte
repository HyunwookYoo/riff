<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import type { RepoEntry } from "$lib/types";

  // A repo selector tab strip, shared by History and Changes. The caller owns
  // the selected index (historyRepoIdx / changesRepoIdx) and the select action.
  let { value, onselect }: { value: number; onselect: (idx: number) => void } =
    $props();

  function label(r: RepoEntry, i: number): string {
    return r.displayName || (i === 0 ? "main" : `repo ${i}`);
  }
</script>

<div class="repo-tabs" role="tablist" aria-label="Repository">
  {#each appState.repos as r, idx (r.path)}
    <button
      type="button"
      class="tab"
      class:active={idx === value}
      role="tab"
      aria-selected={idx === value}
      title={r.path}
      onclick={() => onselect(idx)}
    >
      <span class="name">{label(r, idx)}</span>
      {#if r.kind !== "main"}
        <span class="kind" data-kind={r.kind}>{r.kind}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .repo-tabs {
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    padding: 0 4px;
    min-height: 30px;
    flex-shrink: 0;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: none;
    border-right: 1px solid var(--border);
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.85em;
    white-space: nowrap;
    max-width: 240px;
  }
  .tab:hover {
    background: var(--hover);
  }
  .tab.active {
    background: var(--input-bg);
    box-shadow: inset 0 -2px 0 var(--accent);
    font-weight: 600;
    color: var(--accent);
  }
  .tab .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
  }
  .tab .kind {
    font-size: 0.7em;
    padding: 1px 5px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--input-bg);
    color: var(--muted);
    border: 1px solid var(--border);
  }
  .tab .kind[data-kind="submodule"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
