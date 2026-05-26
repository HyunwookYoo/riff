<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { removeManualRepoFromWorkspace } from "$lib/workspace";
  import { selectTab } from "$lib/tabs";
  import type { RepoEntry } from "$lib/types";

  // Per-repo file counts derived from the current changed-files set. Submodule
  // gitlink entries are already filtered out upstream in compare.ts so this
  // count matches what FileList will show.
  const fileCountsByRepo = $derived.by<Map<number, number>>(() => {
    const m = new Map<number, number>();
    for (const f of appState.files) {
      m.set(f.repoIdx, (m.get(f.repoIdx) ?? 0) + 1);
    }
    return m;
  });

  // §14.6 #22: in Tab layout activeRepoIdx is always a number. Until Step 9
  // wires the mid-session transition rule, fall back to 0 (main) when the
  // store still has null left over from a Unified session.
  const activeIdx = $derived(appState.activeRepoIdx ?? 0);

  function kindLabel(kind: RepoEntry["kind"]): string {
    return kind;
  }

  function onCloseManual(e: MouseEvent, path: string) {
    e.stopPropagation();
    void removeManualRepoFromWorkspace(path);
  }
</script>

<div class="tabbar" role="tablist" aria-label="Workspace repos">
  {#each appState.repos as r, idx (r.path)}
    {@const count = fileCountsByRepo.get(idx) ?? 0}
    {@const isActive = idx === activeIdx}
    <div
      class="tab"
      class:active={isActive}
      class:dim={count === 0}
      role="tab"
      tabindex="0"
      aria-selected={isActive}
      title={r.path}
      onclick={() => selectTab(idx)}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectTab(idx);
        }
      }}
    >
      <span class="name">{r.displayName}</span>
      <span class="kind" data-kind={r.kind}>{kindLabel(r.kind)}</span>
      {#if r.override}
        <span class="override-dot" title="Branch override active">●</span>
      {/if}
      <span class="count" class:zero={count === 0}>{count}</span>
      {#if r.kind === "manual"}
        <button
          type="button"
          class="close"
          aria-label="Remove repo from workspace"
          title="Remove from workspace"
          onclick={(e) => onCloseManual(e, r.path)}
        >
          ×
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .tabbar {
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    padding: 0 4px;
    gap: 0;
    min-height: 32px;
    flex-shrink: 0;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 4px 10px;
    border: none;
    border-right: 1px solid var(--border);
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.85em;
    white-space: nowrap;
    max-width: 240px;
    position: relative;
  }
  .tab:hover {
    background: var(--hover);
  }
  .tab.active {
    background: var(--input-bg);
    box-shadow: inset 0 -2px 0 var(--accent);
    font-weight: 600;
  }
  .tab.dim:not(.active) {
    opacity: 0.55;
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
  .tab .override-dot {
    color: var(--accent);
    font-size: 0.7em;
  }
  .tab .count {
    font-size: 0.75em;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
    min-width: 1.2em;
    text-align: right;
  }
  .tab .count.zero {
    opacity: 0.4;
  }
  .tab .close {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1em;
    padding: 0 4px;
    border-radius: 3px;
    line-height: 1;
  }
  .tab .close:hover {
    background: var(--error-bg);
    color: var(--error-fg);
  }
</style>
