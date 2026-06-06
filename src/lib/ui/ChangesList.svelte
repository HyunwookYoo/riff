<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { isStaged, isUnstaged, openChange } from "$lib/sourceControl";
  import type { StatusEntry } from "$lib/types";

  const entries = $derived(appState.repoStatus?.entries ?? []);
  const unstaged = $derived(entries.filter(isUnstaged));
  const staged = $derived(entries.filter(isStaged));

  function selected(e: StatusEntry, side: "staged" | "unstaged"): boolean {
    return (
      appState.appMode === "changes" &&
      appState.changesSide === side &&
      appState.selectedFile?.path === e.path
    );
  }
  // The status code shown for a side: index (X) when staged, worktree (Y)
  // otherwise. `?` (untracked) is rendered as `A` so the badge reads "added".
  function code(e: StatusEntry, side: "staged" | "unstaged"): string {
    const c = side === "staged" ? e.index_status : e.worktree_status;
    return c === "?" ? "A" : c;
  }
</script>

<div class="changes">
  <section>
    <header>
      <span class="title">Unstaged</span>
      <span class="count">{unstaged.length}</span>
    </header>
    {#if appState.loadingStatus && unstaged.length === 0}
      <div class="empty">Loading…</div>
    {:else if unstaged.length === 0}
      <div class="empty">No unstaged changes</div>
    {:else}
      {#each unstaged as e (e.path)}
        <button
          type="button"
          class="row"
          class:active={selected(e, "unstaged")}
          onclick={() => openChange(e, "unstaged")}
          title={e.path}
        >
          <span class="badge" data-code={code(e, "unstaged")}>
            {code(e, "unstaged")}
          </span>
          <span class="path">{e.path}</span>
        </button>
      {/each}
    {/if}
  </section>

  <section>
    <header>
      <span class="title">Staged</span>
      <span class="count">{staged.length}</span>
    </header>
    {#if staged.length === 0}
      <div class="empty">No staged changes</div>
    {:else}
      {#each staged as e (e.path)}
        <button
          type="button"
          class="row"
          class:active={selected(e, "staged")}
          onclick={() => openChange(e, "staged")}
          title={e.path}
        >
          <span class="badge" data-code={code(e, "staged")}>
            {code(e, "staged")}
          </span>
          <span class="path">{e.path}</span>
        </button>
      {/each}
    {/if}
  </section>
</div>

<style>
  .changes {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    height: 100%;
  }
  section {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    position: sticky;
    top: 0;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    font-size: 0.78em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    z-index: 1;
  }
  header .count {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  .empty {
    padding: 8px 12px;
    color: var(--muted);
    font-size: 0.85em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 4px 10px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-size: 0.85em;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .badge {
    flex: 0 0 auto;
    width: 1.2em;
    text-align: center;
    font-family: var(--mono);
    font-weight: 600;
    font-size: 0.9em;
  }
  .badge[data-code="A"] {
    color: var(--diff-add-border, #2ea043);
  }
  .badge[data-code="D"] {
    color: var(--diff-del-border, #f85149);
  }
  .badge[data-code="M"],
  .badge[data-code="T"] {
    color: var(--accent, #4a9eff);
  }
  .badge[data-code="R"],
  .badge[data-code="C"] {
    color: var(--muted);
  }
  .badge[data-code="U"] {
    color: #d29922;
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
</style>
