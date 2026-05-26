<script lang="ts">
  import Self from "./TreeNode.svelte";
  import { appState } from "$lib/store.svelte";
  import type { ChangedFile, FileStatus } from "$lib/types";
  import type { TreeNode } from "./tree";

  let {
    node,
    depth = 0,
    collapsed,
    onToggle,
    repoIdx = 0,
  }: {
    node: TreeNode;
    depth?: number;
    collapsed: Set<string>;
    onToggle: (path: string) => void;
    /// Workspace index (§13.4). Used to disambiguate the active-row check
    /// when the same path exists in multiple repos.
    repoIdx?: number;
  } = $props();

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

  function select(f: ChangedFile) {
    appState.selectedFile = f;
  }

  function leaf(p: string): string {
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
  }
</script>

{#if node.kind === "dir"}
  {@const isCollapsed = collapsed.has(node.path)}
  <button
    type="button"
    class="row dir"
    style="padding-left: {8 + depth * 12}px"
    onclick={() => onToggle(node.path)}
  >
    <span class="chev" class:open={!isCollapsed}>▸</span>
    <span class="path">{node.name}</span>
  </button>
  {#if !isCollapsed}
    {#each node.children as child (child.kind === "dir" ? "d:" + child.path : "f:" + child.file.path)}
      <Self node={child} depth={depth + 1} {collapsed} {onToggle} {repoIdx} />
    {/each}
  {/if}
{:else}
  <button
    type="button"
    class="row file"
    class:active={appState.selectedFile?.path === node.file.path &&
      (appState.selectedFile?.repoIdx ?? 0) === repoIdx}
    style="padding-left: {8 + depth * 12}px"
    title={node.file.old_path
      ? `${node.file.old_path} → ${node.file.path}`
      : node.file.path}
    onclick={() => select(node.file)}
  >
    <span class="badge" data-status={node.file.status}>
      {badge(node.file.status)}
    </span>
    <span class="path">{leaf(node.file.path)}</span>
  </button>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    padding: 4px 10px;
    text-align: left;
    cursor: pointer;
    font-size: 0.85em;
    font-family: var(--mono);
  }
  .row:hover {
    background: var(--hover);
  }
  .row.active {
    background: var(--selected);
    color: var(--selected-fg);
  }
  .row.active :global(.badge) {
    color: white;
  }
  .chev {
    display: inline-block;
    width: 12px;
    flex-shrink: 0;
    transition: transform 0.12s ease;
    opacity: 0.6;
    font-size: 0.7em;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .badge {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    font-weight: 700;
    font-size: 0.75em;
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
    min-width: 0;
  }
  .dir .path {
    opacity: 0.85;
  }
</style>
