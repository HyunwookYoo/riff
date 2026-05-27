<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import type { ChangedFile, FileStatus, RepoEntry } from "$lib/types";
  import { toggleFocus } from "$lib/focus";
  import { buildTree } from "./tree";
  import TreeNode from "./TreeNode.svelte";

  // Multi-root grouping (§13). Each group is one repo's files. When there is
  // only one repo (the common single-repo case) we render without the group
  // header — keeps the UX identical to v0.2.x.
  interface Group {
    idx: number;
    repo: RepoEntry;
    files: ChangedFile[];
  }
  // §14: in Tabs layout, only the active tab's files are shown and the group
  // header / Focus button are suppressed. activeRepoIdx falls back to 0 until
  // Step 9 wires the mid-session transition.
  const isTabMode = $derived(appState.workspaceLayout === "tabs");
  const activeTabIdx = $derived(appState.activeRepoIdx ?? 0);
  const groups = $derived.by((): Group[] => {
    const buckets = new Map<number, ChangedFile[]>();
    for (const f of appState.files) {
      const idx = f.repoIdx ?? 0;
      let bucket = buckets.get(idx);
      if (!bucket) {
        bucket = [];
        buckets.set(idx, bucket);
      }
      bucket.push(f);
    }
    // Iterate repos in their workspace order so the layout is stable.
    // Unified + Focus: emit only the active repo's group when activeRepoIdx
    // is non-null. Tabs: always emit only the active tab.
    const out: Group[] = [];
    for (let i = 0; i < appState.repos.length; i++) {
      if (isTabMode) {
        if (i !== activeTabIdx) continue;
      } else if (
        appState.activeRepoIdx !== null &&
        appState.activeRepoIdx !== i
      ) {
        continue;
      }
      out.push({ idx: i, repo: appState.repos[i], files: buckets.get(i) ?? [] });
    }
    return out;
  });
  // Group header is shown only in Unified multi-root view. In Tab mode the
  // active repo is conveyed by the tab bar above, so the header would be
  // redundant noise.
  const showGroups = $derived(!isTabMode && appState.repos.length > 1);

  // Tree-mode local state. Directory collapses are keyed by `<repoIdx>:<path>`
  // so the same path in two repos doesn't share a collapse state.
  let collapsedDirs = $state(new Set<string>());

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

  function toggleDir(path: string) {
    const next = new Set(collapsedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsedDirs = next;
  }

  function toggleRepo(idx: number) {
    const next = new Set(appState.collapsedRepos);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    appState.collapsedRepos = next;
  }

  function toggleViewMode() {
    appState.fileViewMode = appState.fileViewMode === "flat" ? "tree" : "flat";
  }

  function isSelected(f: ChangedFile): boolean {
    const sel = appState.selectedFile;
    if (!sel) return false;
    return sel.path === f.path && (sel.repoIdx ?? 0) === (f.repoIdx ?? 0);
  }

  function kindLabel(kind: RepoEntry["kind"]): string {
    switch (kind) {
      case "main":
        return "main";
      case "submodule":
        return "submodule";
      case "manual":
        return "manual";
    }
  }

  // Header count: in Tab mode the user is looking at one repo, so show that
  // repo's file count rather than the workspace-wide total. Empty-state check
  // mirrors the same scope.
  const visibleFileCount = $derived.by<number>(() => {
    if (!isTabMode) return appState.files.length;
    let n = 0;
    for (const f of appState.files) {
      if ((f.repoIdx ?? 0) === activeTabIdx) n++;
    }
    return n;
  });
</script>

<aside class="file-list">
  <header>
    <span>Files</span>
    <span class="count">{visibleFileCount}</span>
    {#if appState.loadingFiles && appState.files.length > 0}
      <span class="scanning">Scanning…</span>
    {/if}
    <button
      type="button"
      class="view-toggle"
      title="Toggle flat/tree view"
      onclick={toggleViewMode}
    >
      {appState.fileViewMode === "flat" ? "Tree" : "Flat"}
    </button>
  </header>

  <div class="scroll">
    {#if visibleFileCount === 0 && !appState.loadingFiles}
      <div class="empty">No changed files.</div>
    {/if}

    {#each groups as group (group.idx)}
      {#if showGroups}
        {@const isFocused = appState.activeRepoIdx === group.idx}
        <div
          class="group-header"
          class:collapsed={appState.collapsedRepos.has(group.idx)}
          class:focused={isFocused}
          title={group.repo.path}
        >
          <button
            type="button"
            class="name-toggle"
            title="Show / hide this repo's files"
            onclick={() => toggleRepo(group.idx)}
          >
            <span class="caret" aria-hidden="true">
              {appState.collapsedRepos.has(group.idx) ? "▸" : "▾"}
            </span>
            <span class="repo-name">{group.repo.displayName}</span>
            <span class="kind-badge" data-kind={group.repo.kind}>
              {kindLabel(group.repo.kind)}
            </span>
            <span class="group-count">{group.files.length}</span>
          </button>
          <button
            type="button"
            class="enter-btn"
            class:focused={isFocused}
            title={isFocused
              ? "Exit Focus (back to multi-root)"
              : "Enter this repo — edits refs above"}
            aria-label={isFocused ? "Exit focus" : "Focus on this repo"}
            onclick={() => toggleFocus(group.idx)}
          >
            {isFocused ? "←" : "→"}
          </button>
        </div>
        {#if group.repo.kind !== "main" && group.repo.override}
          <div
            class="group-refs"
            class:focused={isFocused}
            title={`${group.repo.override.startBranch} → ${group.repo.override.targetBranch}`}
          >
            <span class="ref">{group.repo.override.startBranch}</span>
            <span class="arrow" aria-hidden="true">→</span>
            <span class="ref">{group.repo.override.targetBranch}</span>
          </div>
        {/if}
      {/if}

      {#if !showGroups || !appState.collapsedRepos.has(group.idx)}
        {#if appState.fileViewMode === "tree"}
          {#each buildTree(group.files) as node (node.kind === "dir" ? "d:" + group.idx + ":" + node.path : "f:" + group.idx + ":" + node.file.path)}
            <TreeNode
              {node}
              collapsed={collapsedDirs}
              onToggle={(p) => toggleDir(group.idx + ":" + p)}
              repoIdx={group.idx}
            />
          {/each}
        {:else}
          <ul>
            {#each group.files as f (group.idx + ":" + f.path)}
              <li>
                <button
                  type="button"
                  class:active={isSelected(f)}
                  onclick={() => select(f)}
                  title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                >
                  <span class="badge" data-status={f.status}>{badge(f.status)}</span>
                  <span class="path">{f.path}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    {/each}
  </div>
</aside>

<style>
  .file-list {
    display: flex;
    flex-direction: column;
    height: 100%;
    border-right: 1px solid var(--border);
    background: var(--sidebar-bg);
    min-width: 0;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.7;
    border-bottom: 1px solid var(--border);
    gap: 8px;
  }
  .count {
    font-weight: 400;
    opacity: 0.6;
    margin-left: 6px;
  }
  .scanning {
    font-weight: 400;
    opacity: 0.6;
    text-transform: none;
    letter-spacing: 0;
    font-style: italic;
  }
  .view-toggle {
    margin-left: auto;
  }
  .view-toggle {
    font-size: 0.85em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
    opacity: 1;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .scroll {
    overflow-y: auto;
    flex: 1;
  }
  .empty {
    padding: 12px 10px;
    color: var(--muted);
    font-size: 0.85em;
  }
  ul button {
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
  ul button:hover {
    background: var(--hover);
  }
  ul button.active {
    background: var(--selected);
    color: var(--selected-fg);
  }
  ul button.active .badge {
    /* status badges keep their semantic color; force white text contrast */
    color: white;
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
  .group-header {
    display: flex;
    align-items: stretch;
    width: 100%;
    background: var(--bar-bg);
    color: inherit;
    font-size: 0.8em;
    font-weight: 600;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    user-select: none;
  }
  .group-header.focused {
    background: var(--accent-soft);
  }
  .group-header.collapsed .name-toggle {
    opacity: 0.7;
  }
  .group-header .name-toggle {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: transparent;
    color: inherit;
    padding: 4px 10px;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    min-width: 0;
  }
  .group-header .name-toggle:hover {
    background: var(--hover);
  }
  .group-header .caret {
    width: 12px;
    flex-shrink: 0;
    opacity: 0.6;
    font-size: 0.85em;
  }
  .group-header .repo-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .group-header .group-count {
    opacity: 0.55;
    font-weight: 400;
    font-size: 0.85em;
  }
  .group-refs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px 4px 28px;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-family: var(--mono);
    font-size: 0.72em;
    user-select: none;
    overflow: hidden;
    cursor: help;
  }
  .group-refs.focused {
    background: var(--accent-soft);
  }
  .group-refs .ref {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 0 1 auto;
  }
  .group-refs .arrow {
    flex-shrink: 0;
    opacity: 0.6;
  }
  .group-header .enter-btn {
    border: none;
    border-left: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    padding: 4px 10px;
    cursor: pointer;
    font-size: 0.95em;
    font-family: var(--mono);
    line-height: 1;
  }
  .group-header .enter-btn:hover {
    background: var(--hover);
    color: inherit;
  }
  .group-header .enter-btn.focused {
    color: var(--accent);
  }
  .kind-badge {
    font-size: 0.7em;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--input-bg);
    color: var(--muted);
    border: 1px solid var(--border);
  }
  .kind-badge[data-kind="submodule"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }
  .kind-badge[data-kind="manual"] {
    background: var(--input-bg);
  }
</style>
