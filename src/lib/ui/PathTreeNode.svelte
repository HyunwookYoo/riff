<script lang="ts">
  import type { TreePathNode } from "./pathTree";
  import Self from "./PathTreeNode.svelte";

  interface Props {
    node: TreePathNode;
    expanded: Set<string>;
    /** Prefix applied to dir paths when looking up `expanded` (§13.3 #20).
     * In multi-root, callers pass "<repoIdx>:" so the same directory path
     * in two different repos has independent collapse state. Defaults to
     * "" for single-repo / legacy callers. */
    groupKeyPrefix?: string;
    selectedPath: string | null;
    /** Path under the search keyboard cursor — visually marked but doesn't
     * load. Used during fuzzy-filtered tree mode. */
    highlightedPath?: string | null;
    depth?: number;
    onSelectFile: (path: string) => void;
    onToggleDir: (path: string) => void;
  }

  let {
    node,
    expanded,
    groupKeyPrefix = "",
    selectedPath,
    highlightedPath = null,
    depth = 0,
    onSelectFile,
    onToggleDir,
  }: Props = $props();

  // 8px base indent + 12px per depth level. Caret/icon eats the first 14px.
  const indentPx = $derived(depth * 12 + 8);
</script>

{#if node.kind === "dir"}
  {@const isOpen = expanded.has(groupKeyPrefix + node.path)}
  <button
    type="button"
    class="row dir-row"
    style="padding-left: {indentPx}px"
    onclick={() => onToggleDir(node.path)}
    title={node.path}
  >
    <span class="caret" class:open={isOpen} aria-hidden="true">▸</span>
    <svg
      class="icon folder-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
    <span class="name">{node.name}</span>
  </button>
  {#if isOpen}
    {#each node.children as child (child.kind === "dir" ? "d:" + child.path : "f:" + child.path)}
      <Self
        node={child}
        {expanded}
        {groupKeyPrefix}
        {selectedPath}
        {highlightedPath}
        depth={depth + 1}
        {onSelectFile}
        {onToggleDir}
      />
    {/each}
  {/if}
{:else}
  <button
    type="button"
    class="row file-row"
    class:active={selectedPath === node.path}
    class:highlighted={highlightedPath === node.path}
    style="padding-left: {indentPx + 14}px"
    data-path={node.path}
    onclick={() => onSelectFile(node.path)}
    title={node.path}
  >
    <svg
      class="icon file-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
    <span class="name">{node.name}</span>
  </button>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    padding: 3px 8px 3px 0;
    text-align: left;
    cursor: pointer;
    font-size: 0.82em;
    font-family: var(--mono);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.active {
    background: var(--selected);
    color: var(--selected-fg);
  }
  .row.active .file-icon {
    color: var(--selected-fg);
    opacity: 1;
  }
  .row.highlighted {
    background: var(--hover);
    box-shadow: inset 2px 0 var(--accent);
  }
  .dir-row {
    opacity: 0.85;
    font-weight: 500;
  }
  .caret {
    display: inline-block;
    width: 12px;
    margin-right: 2px;
    font-size: 0.7em;
    opacity: 0.6;
    transition: transform 0.1s ease;
    flex-shrink: 0;
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    margin-right: 6px;
  }
  .folder-icon {
    /* Slightly warm tint so folders read as "containers" vs neutral files. */
    color: var(--accent);
    opacity: 0.75;
  }
  .file-icon {
    opacity: 0.55;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
</style>
