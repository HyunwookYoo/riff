<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    conflictedEntries,
    entryConflicted,
    entryToChangedFile,
    selectChange,
  } from "$lib/workingCopy";
  import { setFileViewMode } from "$lib/git";
  import { buildPathTree, type TreePathNode } from "./pathTree";
  import type { ChangedFile, FileStatus, StatusEntry } from "$lib/types";

  // path → status entry, to resolve a file's badge and diff.
  const byPath = $derived.by(() => {
    const m = new Map<string, StatusEntry>();
    for (const e of appState.repoStatus?.entries ?? []) m.set(e.path, e);
    return m;
  });

  // Unmerged files, surfaced in a dedicated group above the rest.
  const conflicts = $derived(conflictedEntries());
  const changed = $derived(
    (appState.repoStatus?.entries ?? []).filter((e) => !entryConflicted(e)),
  );

  function badge(s: FileStatus): string {
    return { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechanged: "T" }[s];
  }

  function isSel(path: string): boolean {
    return appState.appMode === "changes" && appState.selectedFile?.path === path;
  }
  function pick(path: string) {
    const e = byPath.get(path);
    if (e) selectChange(entryToChangedFile(e, "unstaged"), "unstaged");
  }

  // Tree-view directory collapse, keyed by path.
  let collapsedDirs = $state(new Set<string>());
  function toggleDir(key: string) {
    const n = new Set(collapsedDirs);
    n.has(key) ? n.delete(key) : n.add(key);
    collapsedDirs = n;
  }
  // Flat ⇄ tree, shared with the global file-view setting (FileList's toggle).
  function toggleViewMode() {
    const next = appState.fileViewMode === "flat" ? "tree" : "flat";
    appState.fileViewMode = next;
    void setFileViewMode(next);
  }
</script>

<!-- One file row. `depth = null` → flat (full path); a number → tree (leaf name
     + indent). -->
{#snippet row(path: string, label: string | null, depth: number | null = null)}
  {@const e = byPath.get(path)}
  {#if e}
    {@const cf = entryToChangedFile(e, "unstaged") as ChangedFile}
    <div class="cl-file" class:active={isSel(path)} data-path={path}>
      <button
        type="button"
        class="cl-pick"
        style={depth === null ? "" : `padding-left: ${18 + depth * 12}px`}
        onclick={() => pick(path)}
        title={cf.old_path ? `${cf.old_path} → ${path}` : path}
      >
        <span class="fbadge" data-status={cf.status}>{badge(cf.status)}</span>
        <span class="fpath" class:leaf={depth !== null}>{label ?? path}</span>
      </button>
    </div>
  {/if}
{/snippet}

<!-- Recursive tree of the changed files (dirs collapsible). -->
{#snippet treeNodes(nodes: TreePathNode[], depth: number)}
  {#each nodes as node (node.kind === "dir" ? "d:" + node.path : "f:" + node.path)}
    {#if node.kind === "dir"}
      {@const open = !collapsedDirs.has(node.path)}
      <button
        type="button"
        class="cl-dir"
        style="padding-left: {18 + depth * 12}px"
        onclick={() => toggleDir(node.path)}
      >
        <span class="chev" class:open>▸</span>
        <span class="dname">{node.name}</span>
      </button>
      {#if open}
        {@render treeNodes(node.children, depth + 1)}
      {/if}
    {:else}
      {@render row(node.path, node.name, depth)}
    {/if}
  {/each}
{/snippet}

<div class="cl-root">
  <div class="cl-toolbar">
    <button
      type="button"
      class="view-toggle"
      title={appState.fileViewMode === "flat"
        ? "Switch to tree view"
        : "Switch to flat view"}
      onclick={toggleViewMode}
    >
      {appState.fileViewMode === "flat" ? "Tree" : "Flat"}
    </button>
  </div>

  <div class="cl-scroll">
    {#if conflicts.length > 0}
      <div class="cl-group conflicts">
        <div class="cl-head">Conflicts ({conflicts.length})</div>
        {#each conflicts as e (e.path)}
          {@render row(e.path, null)}
        {/each}
      </div>
    {/if}

    {#if changed.length > 0}
      <div class="cl-group">
        {#if appState.fileViewMode === "tree"}
          {@render treeNodes(buildPathTree(changed.map((e) => e.path)), 0)}
        {:else}
          {#each changed as e (e.path)}
            {@render row(e.path, null)}
          {/each}
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .cl-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .cl-toolbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .view-toggle {
    flex-shrink: 0;
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--muted);
    cursor: pointer;
    font-size: 0.78em;
  }
  .view-toggle:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .cl-scroll {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
  }
  .cl-head {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    border-top: 1px solid var(--border);
  }
  .cl-file {
    display: flex;
    align-items: center;
  }
  .cl-file:hover {
    background: var(--hover);
  }
  .cl-file.active {
    background: var(--accent-soft);
  }
  .cl-file.active .fpath {
    color: var(--accent);
  }
  .cl-pick {
    display: flex;
    align-items: center;
    gap: 9px;
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    padding: 5px 10px 5px 26px;
    font-size: 0.85em;
    user-select: none;
    touch-action: none;
  }
  .fbadge {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    font-weight: 700;
    font-size: 0.72em;
    color: white;
  }
  .fbadge[data-status="added"] { background: #16a34a; }
  .fbadge[data-status="modified"] { background: #ca8a04; }
  .fbadge[data-status="deleted"] { background: #dc2626; }
  .fbadge[data-status="renamed"] { background: #2563eb; }
  .fbadge[data-status="copied"] { background: #0891b2; }
  .fbadge[data-status="typechanged"] { background: #7c3aed; }
  .fpath {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    min-width: 0;
  }
  /* Tree-view leaf name: short, left-to-right (no rtl ellipsis). */
  .fpath.leaf {
    direction: ltr;
  }
  .cl-dir {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    padding: 4px 10px;
    font-size: 0.84em;
    font-family: var(--mono);
    user-select: none;
  }
  .cl-dir:hover {
    background: var(--hover);
  }
  .cl-dir .chev {
    display: inline-block;
    width: 10px;
    flex-shrink: 0;
    opacity: 0.6;
    font-size: 0.7em;
    transition: transform 0.12s ease;
  }
  .cl-dir .chev.open {
    transform: rotate(90deg);
  }
  .cl-dir .dname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.85;
  }
</style>
