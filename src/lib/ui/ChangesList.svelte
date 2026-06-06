<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    isStaged,
    isUnstaged,
    openChange,
    stageAll,
    stageEntry,
    unstageAll,
    unstageEntry,
  } from "$lib/sourceControl";
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
      {#if unstaged.length > 0}
        <button type="button" class="bulk" onclick={() => void stageAll()}>
          Stage all
        </button>
      {/if}
    </header>
    {#if appState.loadingStatus && unstaged.length === 0}
      <div class="empty">Loading…</div>
    {:else if unstaged.length === 0}
      <div class="empty">No unstaged changes</div>
    {:else}
      {#each unstaged as e (e.path)}
        <div class="row" class:active={selected(e, "unstaged")}>
          <button
            type="button"
            class="select"
            onclick={() => openChange(e, "unstaged")}
            title={e.path}
          >
            <span class="badge" data-code={code(e, "unstaged")}>
              {code(e, "unstaged")}
            </span>
            <span class="path">{e.path}</span>
          </button>
          <button
            type="button"
            class="action"
            title="Stage this file"
            aria-label="Stage {e.path}"
            onclick={() => void stageEntry(e)}
          >
            +
          </button>
        </div>
      {/each}
    {/if}
  </section>

  <section>
    <header>
      <span class="title">Staged</span>
      <span class="count">{staged.length}</span>
      {#if staged.length > 0}
        <button type="button" class="bulk" onclick={() => void unstageAll()}>
          Unstage all
        </button>
      {/if}
    </header>
    {#if staged.length === 0}
      <div class="empty">No staged changes</div>
    {:else}
      {#each staged as e (e.path)}
        <div class="row" class:active={selected(e, "staged")}>
          <button
            type="button"
            class="select"
            onclick={() => openChange(e, "staged")}
            title={e.path}
          >
            <span class="badge" data-code={code(e, "staged")}>
              {code(e, "staged")}
            </span>
            <span class="path">{e.path}</span>
          </button>
          <button
            type="button"
            class="action"
            title="Unstage this file"
            aria-label="Unstage {e.path}"
            onclick={() => void unstageEntry(e)}
          >
            −
          </button>
        </div>
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
  header .bulk {
    margin-left: auto;
    padding: 1px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.95em;
    text-transform: none;
    letter-spacing: 0;
  }
  header .bulk:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .empty {
    padding: 8px 12px;
    color: var(--muted);
    font-size: 0.85em;
  }
  .row {
    display: flex;
    align-items: stretch;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.active {
    background: var(--accent-soft);
  }
  .row.active .path {
    color: var(--accent);
  }
  .select {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 4px 10px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-size: 0.85em;
  }
  .action {
    flex: 0 0 auto;
    width: 26px;
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
    opacity: 0;
  }
  .row:hover .action,
  .row.active .action {
    opacity: 1;
  }
  .action:hover {
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
