<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    entryToChangedFile,
    isStaged,
    isUnstaged,
    selectChange,
    stageAll,
    stagePath,
    unstageAll,
    unstagePath,
  } from "$lib/sourceControl";
  import { buildTree, type TreeNode } from "./tree";
  import type { ChangedFile, FileStatus } from "$lib/types";

  type Side = "staged" | "unstaged";

  const entries = $derived(appState.repoStatus?.entries ?? []);
  const unstagedFiles = $derived(
    entries.filter(isUnstaged).map((e) => entryToChangedFile(e, "unstaged")),
  );
  const stagedFiles = $derived(
    entries.filter(isStaged).map((e) => entryToChangedFile(e, "staged")),
  );
  const isTree = $derived(appState.fileViewMode === "tree");

  // Flattened tree rows (dirs + files) with depth, respecting collapsed dirs.
  type Row =
    | { kind: "dir"; name: string; path: string; depth: number }
    | { kind: "file"; file: ChangedFile; depth: number };

  // Directory collapse state, keyed `<side>:<dirPath>` so the two panes are
  // independent.
  let collapsedDirs = $state(new Set<string>());
  function toggleDir(side: Side, path: string) {
    const key = side + ":" + path;
    const next = new Set(collapsedDirs);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedDirs = next;
  }

  function flatten(nodes: TreeNode[], side: Side, depth: number, out: Row[]): Row[] {
    for (const n of nodes) {
      if (n.kind === "dir") {
        out.push({ kind: "dir", name: n.name, path: n.path, depth });
        if (!collapsedDirs.has(side + ":" + n.path)) {
          flatten(n.children, side, depth + 1, out);
        }
      } else {
        out.push({ kind: "file", file: n.file, depth });
      }
    }
    return out;
  }
  const unstagedRows = $derived(flatten(buildTree(unstagedFiles), "unstaged", 0, []));
  const stagedRows = $derived(flatten(buildTree(stagedFiles), "staged", 0, []));

  function basename(p: string): string {
    const i = p.lastIndexOf("/");
    return i < 0 ? p : p.slice(i + 1);
  }

  function badge(s: FileStatus): string {
    switch (s) {
      case "added":
        return "A";
      case "modified":
        return "M";
      case "deleted":
        return "D";
      case "renamed":
        return "R";
      case "copied":
        return "C";
      case "typechanged":
        return "T";
    }
  }

  function selFile(f: ChangedFile, side: Side): boolean {
    return (
      appState.appMode === "changes" &&
      appState.changesSide === side &&
      appState.selectedFile?.path === f.path
    );
  }

  // Draggable divider between the Unstaged (top) and Staged (bottom) panes.
  let rootEl = $state<HTMLDivElement | null>(null);
  let resizing = $state(false);
  function onSplitStart(e: PointerEvent) {
    if (e.button !== 0 || !rootEl) return;
    e.preventDefault();
    resizing = true;
    const rect = rootEl.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const f = (ev.clientY - rect.top) / rect.height;
      appState.changesPaneFraction = Math.min(0.85, Math.max(0.15, f));
    };
    const onUp = () => {
      resizing = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
</script>

{#snippet fileRow(f: ChangedFile, side: Side, depth: number, name: string)}
  <div class="row" class:active={selFile(f, side)}>
    <button
      type="button"
      class="select"
      style="padding-left: {10 + depth * 14}px"
      onclick={() => selectChange(f, side)}
      title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
    >
      <span class="badge" data-status={f.status}>{badge(f.status)}</span>
      <span class="path">{name}</span>
    </button>
    <button
      type="button"
      class="action"
      title={side === "staged" ? "Unstage this file" : "Stage this file"}
      aria-label={side === "staged" ? `Unstage ${f.path}` : `Stage ${f.path}`}
      onclick={() => void (side === "staged" ? unstagePath(f.path) : stagePath(f.path))}
    >
      {side === "staged" ? "−" : "+"}
    </button>
  </div>
{/snippet}

{#snippet dirRow(side: Side, path: string, name: string, depth: number)}
  <button
    type="button"
    class="dir"
    style="padding-left: {8 + depth * 14}px"
    onclick={() => toggleDir(side, path)}
  >
    <span class="caret" aria-hidden="true">
      {collapsedDirs.has(side + ":" + path) ? "▸" : "▾"}
    </span>
    <span class="dir-name">{name}</span>
  </button>
{/snippet}

{#snippet paneBody(files: ChangedFile[], rows: Row[], side: Side, loading: boolean)}
  {#if loading && files.length === 0}
    <div class="empty">Loading…</div>
  {:else if files.length === 0}
    <div class="empty">
      {side === "staged" ? "No staged changes" : "No unstaged changes"}
    </div>
  {:else if isTree}
    {#each rows as row (row.kind === "dir" ? "d:" + row.path : "f:" + row.file.path)}
      {#if row.kind === "dir"}
        {@render dirRow(side, row.path, row.name, row.depth)}
      {:else}
        {@render fileRow(row.file, side, row.depth, basename(row.file.path))}
      {/if}
    {/each}
  {:else}
    {#each files as f (f.path)}
      {@render fileRow(f, side, 0, f.path)}
    {/each}
  {/if}
{/snippet}

<div
  class="changes"
  class:resizing
  bind:this={rootEl}
  style="--top: {appState.changesPaneFraction};"
>
  <section class="pane unstaged-pane">
    <header>
      <span class="title">Unstaged</span>
      <span class="count">{unstagedFiles.length}</span>
      {#if unstagedFiles.length > 0}
        <button type="button" class="bulk" onclick={() => void stageAll()}>
          Stage all
        </button>
      {/if}
    </header>
    <div class="rows">
      {@render paneBody(
        unstagedFiles,
        unstagedRows,
        "unstaged",
        appState.loadingStatus,
      )}
    </div>
  </section>

  <div
    class="vsplit"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize unstaged / staged"
    onpointerdown={onSplitStart}
  ></div>

  <section class="pane staged-pane">
    <header>
      <span class="title">Staged</span>
      <span class="count">{stagedFiles.length}</span>
      {#if stagedFiles.length > 0}
        <button type="button" class="bulk" onclick={() => void unstageAll()}>
          Unstage all
        </button>
      {/if}
    </header>
    <div class="rows">
      {@render paneBody(stagedFiles, stagedRows, "staged", false)}
    </div>
  </section>
</div>

<style>
  .changes {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }
  .changes.resizing {
    cursor: row-resize;
    user-select: none;
  }
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .unstaged-pane {
    flex: 0 0 calc(var(--top, 0.5) * 100%);
  }
  .staged-pane {
    flex: 1 1 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    flex-shrink: 0;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    font-size: 0.82em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  header .count {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  header .bulk {
    margin-left: auto;
    padding: 2px 9px;
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
  .rows {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
  }
  .empty {
    padding: 10px 12px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .vsplit {
    flex: 0 0 7px;
    margin: -3px 0;
    z-index: 5;
    cursor: row-resize;
    background: transparent;
    position: relative;
  }
  .vsplit::after {
    content: "";
    position: absolute;
    left: 0;
    top: 3px;
    height: 1px;
    width: 100%;
    background: var(--border);
    transition: background 0.1s ease;
  }
  .vsplit:hover::after,
  .changes.resizing .vsplit::after {
    background: var(--accent);
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
    gap: 9px;
    flex: 1;
    min-width: 0;
    padding: 7px 10px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-size: 0.95em;
  }
  .dir {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-size: 0.92em;
    user-select: none;
  }
  .dir:hover {
    background: var(--hover);
  }
  .dir .caret {
    width: 12px;
    flex-shrink: 0;
    opacity: 0.6;
    font-size: 0.85em;
  }
  .dir .dir-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.85;
  }
  .action {
    flex: 0 0 auto;
    width: 30px;
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.25em;
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
  .badge[data-status="added"] {
    background: #16a34a;
  }
  .badge[data-status="modified"] {
    background: #ca8a04;
  }
  .badge[data-status="deleted"] {
    background: #dc2626;
  }
  .badge[data-status="renamed"] {
    background: #2563eb;
  }
  .badge[data-status="copied"] {
    background: #0891b2;
  }
  .badge[data-status="typechanged"] {
    background: #7c3aed;
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
</style>
