<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    conflictedEntries,
    discardPath,
    doStashSave,
    entryToChangedFile,
    selectChange,
  } from "$lib/sourceControl";
  import { setFileViewMode } from "$lib/git";
  import { confirmAction } from "$lib/dialogs";
  import {
    DEFAULT_CHANGELIST,
    commitChangelist,
    createChangelist,
    deleteChangelist,
    fileHunksInList,
    filesInChangelist,
    moveFilesToChangelist,
    renameChangelist,
  } from "$lib/changelists";
  import { buildPathTree, type TreePathNode } from "./pathTree";
  import {
    applyClick,
    defaultStashMessage,
    type ClickKind,
  } from "./changesSelect";
  import type { ChangedFile, FileStatus, StatusEntry } from "$lib/types";

  // path → status entry, to resolve a file's badge/diff from its changelist.
  const byPath = $derived.by(() => {
    const m = new Map<string, StatusEntry>();
    for (const e of appState.repoStatus?.entries ?? []) m.set(e.path, e);
    return m;
  });

  // The multi-selection, pruned to files that are still changed. Every read
  // goes through this — never the raw store set — so a path that has just been
  // stashed or committed cannot reach a git call, and no $effect is needed to
  // clean up after a refresh.
  const sel = $derived(
    new Set([...appState.changesSelectedPaths].filter((p) => byPath.has(p))),
  );

  // Unmerged files, surfaced in a dedicated group above the changelists.
  const conflicts = $derived(conflictedEntries());

  function badge(s: FileStatus): string {
    return { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechanged: "T" }[s];
  }

  // "k/n" when a file's hunks are split — only k of its n hunks are in `clId`.
  // Empty when the whole file is in this list (or it has no hunk data).
  function hunkBadge(path: string, clId: string): string {
    const sub = fileHunksInList(path, clId);
    if (!sub || sub.ids.length === sub.total) return "";
    return `${sub.ids.length}/${sub.total}`;
  }

  function isSel(path: string): boolean {
    return appState.appMode === "changes" && appState.selectedFile?.path === path;
  }
  function pick(path: string) {
    const e = byPath.get(path);
    if (e) selectChange(entryToChangedFile(e, "unstaged"), "unstaged");
  }

  // On-screen row order, read straight from the DOM so a range fill always
  // matches what the user sees — collapsed changelists, collapsed directories
  // and flat-vs-tree all fall out for free. Conflict rows carry no data-path,
  // so they can never be selected (git stash fails on unmerged paths).
  let rootEl = $state<HTMLElement | null>(null);
  function rowOrder(): string[] {
    if (!rootEl) return [];
    return [...rootEl.querySelectorAll<HTMLElement>("[data-path]")].map(
      (el) => el.dataset.path ?? "",
    );
  }

  // Ctrl/Cmd+click toggles a file, Shift+click fills the range from the anchor,
  // a plain click drops back to single selection. The diff pane always follows
  // the clicked row.
  let anchor = $state<string | null>(null);
  function onRowClick(e: MouseEvent, path: string) {
    const kind: ClickKind = e.shiftKey
      ? "range"
      : e.ctrlKey || e.metaKey
        ? "toggle"
        : "plain";
    const next = applyClick(
      kind,
      {
        selected: appState.changesSelectedPaths,
        // The pivot only means anything while a selection is live. After any
        // clear (Esc, Clear, repo switch, stash) a Shift+click pivots on the
        // file the diff pane is showing instead of a stale row.
        anchor: appState.changesSelectedPaths.size > 0 ? anchor : null,
      },
      appState.selectedFile?.path ?? null,
      path,
      rowOrder(),
    );
    appState.changesSelectedPaths = next.selected;
    anchor = next.anchor;
    pick(path);
  }

  // Discard a file's changes (destructive) after confirming. A new file (staged-
  // add or untracked) is deleted; everything else reverts to HEAD.
  async function confirmDiscard(path: string) {
    const e = byPath.get(path);
    const isNew =
      !!e &&
      (e.index_status === "A" ||
        (e.index_status === "?" && e.worktree_status === "?"));
    const msg = isNew
      ? `Delete this new file? It is permanently removed from disk and can't be undone.\n\n${path}`
      : `Discard changes to this file? It reverts to HEAD and can't be undone.\n\n${path}`;
    const ok = await confirmAction(msg, {
      title: isNew ? "Delete file" : "Discard changes",
    });
    if (!ok) return;
    void discardPath(path, e?.orig_path ?? null);
  }

  let collapsed = $state(new Set<string>());
  function toggle(id: string) {
    const n = new Set(collapsed);
    n.has(id) ? n.delete(id) : n.add(id);
    collapsed = n;
  }

  // Tree-view directory collapse, keyed `<changelistId>:<dirPath>` so the same
  // directory in two changelists collapses independently.
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

  // Inline create / rename editors.
  let creating = $state(false);
  let createName = $state("");
  function submitCreate() {
    const n = createName.trim();
    creating = false;
    createName = "";
    if (n) appState.activeChangelistId = createChangelist(n);
  }
  let editingId = $state<string | null>(null);
  let editName = $state("");
  function startRename(id: string, name: string) {
    editingId = id;
    editName = name;
  }
  function submitRename() {
    if (editingId) renameChangelist(editingId, editName);
    editingId = null;
  }

  async function doDelete(id: string) {
    if (
      await confirmAction("Delete this changelist? Its files move to Default.", {
        title: "Delete changelist",
      })
    )
      deleteChangelist(id);
  }

  // Move / stash menu (HTML5 drag is intercepted by Tauri's file-drop; a menu
  // is reliable). `paths` is the whole multi-selection when the click landed
  // inside it, else just the clicked file.
  let moveMenu = $state<{ x: number; y: number; paths: string[] } | null>(null);
  function openMove(e: MouseEvent, path: string) {
    e.preventDefault();
    if (sel.has(path)) {
      moveMenu = { x: e.clientX, y: e.clientY, paths: [...sel] };
      return;
    }
    if (sel.size > 0) {
      // Right-clicking outside an active selection re-selects that one row, so
      // the menu can never act on files the user is no longer pointing at.
      appState.changesSelectedPaths = new Set();
      pick(path);
    }
    // With no selection at all this stays the pure peek it has always been:
    // the menu targets the clicked row without touching the diff pane.
    moveMenu = { x: e.clientX, y: e.clientY, paths: [path] };
  }
  function moveTo(targetId: string) {
    // The selection survives a move — regrouping and then stashing is common.
    if (moveMenu) moveFilesToChangelist(moveMenu.paths, targetId);
    moveMenu = null;
  }

  // Stash the selection (or one file): open an inline message field, then stash
  // just those paths. An empty message falls back to a generated subject so the
  // entry is identifiable in the stash list.
  let stashTargets = $state<string[] | null>(null);
  let stashMsg = $state("");
  function openStash() {
    if (!moveMenu) return;
    stashTargets = moveMenu.paths;
    stashMsg = "";
    moveMenu = null;
  }
  function stashSelection() {
    stashTargets = [...sel];
    stashMsg = "";
  }
  function cancelStash() {
    stashTargets = null;
    stashMsg = "";
  }
  function submitStash() {
    const paths = stashTargets;
    stashTargets = null;
    if (!paths || paths.length === 0) return;
    const m = stashMsg.trim() || defaultStashMessage(paths);
    stashMsg = "";
    appState.changesSelectedPaths = new Set();
    anchor = null;
    void doStashSave(m, paths);
  }
  function currentListOf(path: string): string {
    return (
      appState.changelists.find((l) => l.files.includes(path))?.id ??
      DEFAULT_CHANGELIST
    );
  }

  // Pointer-based drag to move a file onto a changelist group (HTML5 drag is
  // intercepted by Tauri's file-drop). A press becomes a drag past a threshold;
  // the group under the cursor is found via its data-cl attribute.
  let dragPaths = $state<string[] | null>(null);
  let ghost = $state<{ x: number; y: number; label: string } | null>(null);
  let dropList = $state<string | null>(null);
  let pending: { path: string; x: number; y: number } | null = null;
  const DRAG_THRESHOLD = 5;

  function groupUnder(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cl]");
    return el?.dataset.cl ?? null;
  }
  function onFilePointerDown(e: PointerEvent, path: string) {
    // A modifier-click is a selection gesture, not the start of a drag.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    pending = { path, x: e.clientX, y: e.clientY };
  }
  function onWinPointerMove(e: PointerEvent) {
    if (dragPaths) {
      ghost = { x: e.clientX, y: e.clientY, label: dragLabel(dragPaths) };
      dropList = groupUnder(e.clientX, e.clientY);
      return;
    }
    if (!pending) return;
    const dx = e.clientX - pending.x;
    const dy = e.clientY - pending.y;
    if (dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
      // Dragging a selected row drags the whole selection; an unselected row
      // drags alone and leaves the selection untouched.
      dragPaths = sel.has(pending.path) ? [...sel] : [pending.path];
      ghost = { x: e.clientX, y: e.clientY, label: dragLabel(dragPaths) };
      pending = null;
    }
  }
  function onWinPointerUp(e: PointerEvent) {
    if (dragPaths) {
      const target = groupUnder(e.clientX, e.clientY);
      if (target) moveFilesToChangelist(dragPaths, target);
      dragPaths = null;
      ghost = null;
      dropList = null;
    }
    pending = null;
  }
  function basename(p: string): string {
    const i = p.lastIndexOf("/");
    return i < 0 ? p : p.slice(i + 1);
  }
  function dragLabel(paths: string[]): string {
    return paths.length > 1 ? `${paths.length} files` : basename(paths[0]);
  }
</script>

<svelte:window
  onclick={() => (moveMenu = null)}
  onpointermove={onWinPointerMove}
  onpointerup={onWinPointerUp}
/>

<!-- One file row. `depth = null` → flat (full path); a number → tree (leaf name
     + indent). Drag / right-click move + selection are identical either way. -->
{#snippet fileRow(
  path: string,
  label: string | null,
  depth: number | null,
  clId: string,
)}
  {@const e = byPath.get(path)}
  {#if e}
    {@const cf = entryToChangedFile(e, "unstaged") as ChangedFile}
    {@const hb = hunkBadge(path, clId)}
    <div
      class="cl-file"
      class:active={isSel(path)}
      class:multi={sel.has(path)}
      data-path={path}
    >
      <button
        type="button"
        class="cl-pick"
        style={depth === null ? "" : `padding-left: ${18 + depth * 12}px`}
        onclick={(ev) => onRowClick(ev, path)}
        onpointerdown={(ev) => onFilePointerDown(ev, path)}
        oncontextmenu={(ev) => openMove(ev, path)}
        title={cf.old_path
          ? `${cf.old_path} → ${path}`
          : `${path} · drag onto a changelist to move`}
      >
        <span class="fbadge" data-status={cf.status}>{badge(cf.status)}</span>
        <span class="fpath" class:leaf={depth !== null}>{label ?? path}</span>
      </button>
      {#if hb}
        <span class="hunks" title="{hb} hunks of this file are in this changelist">
          {hb}
        </span>
      {/if}
      <button
        type="button"
        class="cl-discard"
        title="Discard changes (revert to HEAD)"
        aria-label="Discard changes to {path}"
        onclick={() => confirmDiscard(path)}
      >
        ↩
      </button>
    </div>
  {/if}
{/snippet}

<!-- Recursive tree of one changelist's files (dirs collapsible). -->
{#snippet fileTree(nodes: TreePathNode[], clId: string, depth: number)}
  {#each nodes as node (node.kind === "dir" ? "d:" + node.path : "f:" + node.path)}
    {#if node.kind === "dir"}
      {@const key = clId + ":" + node.path}
      {@const open = !collapsedDirs.has(key)}
      <button
        type="button"
        class="cl-dir"
        style="padding-left: {18 + depth * 12}px"
        onclick={() => toggleDir(key)}
      >
        <span class="chev" class:open>▸</span>
        <span class="dname">{node.name}</span>
      </button>
      {#if open}
        {@render fileTree(node.children, clId, depth + 1)}
      {/if}
    {:else}
      {@render fileRow(node.path, node.name, depth, clId)}
    {/if}
  {/each}
{/snippet}

<div class="cl-root" bind:this={rootEl}>
  {#if stashTargets}
    {@const n = stashTargets.length}
    <form class="cl-stash" onsubmit={(e) => (e.preventDefault(), submitStash())}>
      <span class="cl-stash-label" title={stashTargets.join("\n")}>
        {n > 1 ? `Stash ${n} files:` : `Stash ${stashTargets[0]}:`}
      </span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        bind:value={stashMsg}
        placeholder="message (optional)"
        aria-label="Stash message"
        onkeydown={(e) => e.key === "Escape" && cancelStash()}
      />
    </form>
  {/if}
  {#if sel.size > 0}
    <div class="cl-selbar">
      <span class="cl-selcount">{sel.size} selected</span>
      <button type="button" class="cl-selact" onclick={stashSelection}>
        Stash…
      </button>
      <button
        type="button"
        class="cl-selact"
        onclick={() => (appState.changesSelectedPaths = new Set())}
      >
        Clear
      </button>
    </div>
  {/if}
  <div class="cl-toolbar">
    {#if creating}
      <form class="cl-create" onsubmit={(e) => (e.preventDefault(), submitCreate())}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          bind:value={createName}
          placeholder="Changelist name…"
          onblur={submitCreate}
          onkeydown={(e) => e.key === "Escape" && ((creating = false), (createName = ""))}
        />
      </form>
    {:else}
      <button type="button" class="new-cl" onclick={() => (creating = true)}>
        + New changelist
      </button>
    {/if}
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
      <div class="cl-group" role="group">
        <div class="cl-head conflict-head">
          <span class="warn" aria-hidden="true">⚠</span>
          <span class="conflict-label">Conflicts</span>
          <span class="cnt">{conflicts.length}</span>
        </div>
        {#each conflicts as e (e.path)}
          <div class="cl-file" class:active={isSel(e.path)}>
            <button
              type="button"
              class="cl-pick"
              onclick={() => pick(e.path)}
              title="Resolve {e.path}"
            >
              <span class="fbadge conflict" title="Conflicted">!</span>
              <span class="fpath">{e.path}</span>
            </button>
          </div>
        {/each}
      </div>
    {/if}
    {#each appState.changelists as cl (cl.id)}
      {@const isActive = cl.id === appState.activeChangelistId}
      {@const clFiles = filesInChangelist(cl.id)}
      <div class="cl-group" class:drop={dropList === cl.id} data-cl={cl.id} role="group">
        <div class="cl-head" class:active={isActive}>
          <button type="button" class="caret" onclick={() => toggle(cl.id)} aria-label="Collapse">
            {collapsed.has(cl.id) ? "▸" : "▾"}
          </button>
          <button
            type="button"
            class="cl-name"
            title="Make active (commit box targets this)"
            onclick={() => (appState.activeChangelistId = cl.id)}
          >
            <span class="dot" class:on={isActive} aria-hidden="true"></span>
            {#if editingId === cl.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="rename"
                autofocus
                bind:value={editName}
                onclick={(e) => e.stopPropagation()}
                onblur={submitRename}
                onkeydown={(e) => {
                  if (e.key === "Enter") submitRename();
                  else if (e.key === "Escape") editingId = null;
                }}
              />
            {:else}
              <span class="nm">{cl.name}</span>
            {/if}
            <span class="cnt">{clFiles.length}</span>
          </button>
          <div class="cl-actions">
            {#if clFiles.length > 0}
              <button
                type="button"
                title="Commit this changelist (uses the message box below)"
                disabled={appState.committing || !appState.commitSubject.trim()}
                onclick={() => void commitChangelist(cl.id)}
              >
                ✓
              </button>
            {/if}
            {#if cl.id !== DEFAULT_CHANGELIST}
              <button type="button" title="Rename" onclick={() => startRename(cl.id, cl.name)}>✎</button>
              <button type="button" class="del" title="Delete" onclick={() => doDelete(cl.id)}>🗑</button>
            {/if}
          </div>
        </div>

        {#if !collapsed.has(cl.id)}
          {#if clFiles.length === 0}
            <div class="cl-empty">No files{cl.id === DEFAULT_CHANGELIST ? "" : " — drag here"}</div>
          {:else if appState.fileViewMode === "tree"}
            {@render fileTree(
              buildPathTree(clFiles.map((f) => f.path).filter((p) => byPath.has(p))),
              cl.id,
              0,
            )}
          {:else}
            {#each clFiles as f (f.path)}
              {@render fileRow(f.path, null, null, cl.id)}
            {/each}
          {/if}
        {/if}
      </div>
    {/each}
  </div>
</div>

{#if moveMenu}
  {@const paths = moveMenu.paths}
  {@const n = paths.length}
  <div class="cl-menu" style="left: {moveMenu.x}px; top: {moveMenu.y}px" role="menu">
    <div class="cl-menu-head">
      {n > 1 ? `Move ${n} files to` : "Move to changelist"}
    </div>
    {#each appState.changelists as l (l.id)}
      {@const here = paths.every((p) => currentListOf(p) === l.id)}
      <button
        type="button"
        role="menuitem"
        disabled={here}
        onclick={() => moveTo(l.id)}
      >
        {here ? "● " : ""}{l.name}
      </button>
    {/each}
    <div class="cl-menu-sep"></div>
    <button type="button" role="menuitem" onclick={openStash}>
      {n > 1 ? `Stash ${n} files…` : "Stash this file…"}
    </button>
  </div>
{/if}

{#if ghost}
  <div class="cl-drag-ghost" style="left: {ghost.x}px; top: {ghost.y}px">
    {ghost.label}
  </div>
{/if}

<style>
  .cl-drag-ghost {
    position: fixed;
    z-index: 1500;
    transform: translate(12px, 10px);
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    font-size: 0.78em;
    font-family: var(--mono);
    pointer-events: none;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  }
  .cl-menu {
    position: fixed;
    z-index: 1000;
    min-width: 160px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .cl-menu-head {
    padding: 4px 8px;
    font-size: 0.72em;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border);
    margin-bottom: 2px;
  }
  .cl-menu button {
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 5px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .cl-menu button:hover:not(:disabled) {
    background: var(--hover);
  }
  .cl-menu button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cl-menu-sep {
    height: 1px;
    background: var(--border);
    margin: 4px 0;
  }
  .cl-stash {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
  }
  .cl-stash-label {
    flex: 0 0 auto;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8em;
    color: var(--muted);
    font-family: var(--mono);
  }
  .cl-stash input {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    padding: 4px 8px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.85em;
  }
  .cl-selbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
  }
  .cl-selcount {
    flex: 1;
    min-width: 0;
    font-size: 0.8em;
    color: var(--accent);
  }
  .cl-selact {
    flex: 0 0 auto;
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.78em;
  }
  .cl-selact:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
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
  .cl-create {
    flex: 1;
    min-width: 0;
  }
  .new-cl {
    flex: 1;
    padding: 4px 8px;
    border: 1px dashed var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.85em;
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
  .new-cl:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .cl-create input,
  .rename {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.85em;
  }
  .cl-scroll {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
  }
  .cl-group.drop {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  .cl-head {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    border-top: 1px solid var(--border);
  }
  .cl-head.active {
    background: var(--accent-soft);
  }
  .cl-head.conflict-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    background: var(--error-bg, #3a1d1d);
    color: var(--error-fg, #f0b4b4);
    font-size: 0.85em;
    font-weight: 600;
  }
  .conflict-head .warn {
    flex: 0 0 auto;
  }
  .conflict-head .conflict-label {
    flex: 1;
  }
  .conflict-head .cnt {
    flex: 0 0 auto;
    opacity: 0.8;
    font-weight: 400;
  }
  .cl-head .caret {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 4px 2px 4px 8px;
    font-size: 0.8em;
  }
  .cl-name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 5px 4px;
    text-align: left;
    font-size: 0.85em;
    font-weight: 600;
  }
  .cl-name .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1px solid var(--muted);
    flex-shrink: 0;
  }
  .cl-name .dot.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .cl-name .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cl-name .cnt {
    opacity: 0.6;
    font-weight: 400;
  }
  .cl-actions {
    display: flex;
    flex-shrink: 0;
  }
  .cl-actions button {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 4px 7px;
    font-size: 0.85em;
  }
  .cl-actions button:hover:not(:disabled) {
    color: var(--accent);
  }
  .cl-actions button:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .cl-actions .del:hover {
    color: var(--error-fg, #f85149);
  }
  .cl-empty {
    padding: 6px 12px 6px 28px;
    color: var(--muted);
    font-size: 0.8em;
    font-style: italic;
  }
  .cl-file {
    display: flex;
    align-items: center;
  }
  .cl-file:hover {
    background: var(--hover);
  }
  .cl-discard {
    flex: 0 0 auto;
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 4px 9px;
    font-size: 0.95em;
    line-height: 1;
    opacity: 0;
  }
  .cl-file:hover .cl-discard,
  .cl-discard:focus-visible {
    opacity: 1;
  }
  .cl-discard:hover {
    color: var(--error-fg, #f85149);
  }
  .hunks {
    flex: 0 0 auto;
    font-size: 0.72em;
    font-family: var(--mono);
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 7px;
    padding: 0 6px;
    margin-right: 2px;
  }
  .cl-file.multi {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
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
  .fbadge.conflict { background: var(--error-fg, #f85149); }
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
