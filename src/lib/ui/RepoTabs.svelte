<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { reorderRepo } from "$lib/workspace";
  import type { RepoEntry } from "$lib/types";

  // A repo selector tab strip, shared by History and Changes. The caller owns
  // the selected index (historyRepoIdx / changesRepoIdx) and the select action.
  let { value, onselect }: { value: number; onselect: (idx: number) => void } =
    $props();

  function label(r: RepoEntry, i: number): string {
    return r.displayName || (i === 0 ? "main" : `repo ${i}`);
  }

  // Pointer-based drag to reorder tabs — Tauri's file-drop intercepts HTML5
  // drag, so a press becomes a drag past a threshold. Main (idx 0) is pinned.
  let pending: { idx: number; x: number } | null = null;
  let dragIdx = $state<number | null>(null);
  let dropIdx = $state<number | null>(null);
  let suppressClick = false;
  const THRESHOLD = 5;

  function tabUnder(x: number, y: number): number | null {
    const el = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-tabidx]");
    if (!el) return null;
    const i = Number(el.dataset.tabidx);
    return Number.isInteger(i) ? i : null;
  }
  function onDown(e: PointerEvent, idx: number) {
    if (e.button !== 0 || idx === 0) return; // main is not draggable
    suppressClick = false;
    pending = { idx, x: e.clientX };
  }
  function onMove(e: PointerEvent) {
    if (dragIdx !== null) {
      const t = tabUnder(e.clientX, e.clientY);
      // Can't drop before main.
      dropIdx = t !== null && t !== 0 ? t : null;
      return;
    }
    if (!pending) return;
    if (Math.abs(e.clientX - pending.x) >= THRESHOLD) {
      dragIdx = pending.idx;
      pending = null;
    }
  }
  function onUp() {
    if (dragIdx !== null) {
      if (dropIdx !== null && dropIdx !== dragIdx) {
        reorderRepo(dragIdx, dropIdx);
        suppressClick = true;
      }
      dragIdx = null;
      dropIdx = null;
    }
    pending = null;
  }
  function onClick(idx: number) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    onselect(idx);
  }
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} />

<div class="repo-tabs" role="tablist" aria-label="Repository">
  {#each appState.repos as r, idx (r.path)}
    <button
      type="button"
      class="tab"
      class:active={idx === value}
      class:dragging={idx === dragIdx}
      class:droptarget={idx === dropIdx && dragIdx !== null}
      data-tabidx={idx}
      role="tab"
      aria-selected={idx === value}
      title={idx === 0 ? r.path : `${r.path} · drag to reorder`}
      onpointerdown={(e) => onDown(e, idx)}
      onclick={() => onClick(idx)}
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
    touch-action: none;
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
  .tab.dragging {
    opacity: 0.5;
  }
  /* Drop indicator — accent bar on the left edge of the target tab. */
  .tab.droptarget {
    box-shadow: inset 2px 0 0 var(--accent);
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
