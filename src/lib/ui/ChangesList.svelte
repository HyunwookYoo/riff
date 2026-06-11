<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { entryToChangedFile, selectChange } from "$lib/sourceControl";
  import {
    DEFAULT_CHANGELIST,
    commitChangelist,
    createChangelist,
    deleteChangelist,
    moveFileToChangelist,
    renameChangelist,
  } from "$lib/changelists";
  import type { ChangedFile, FileStatus, StatusEntry } from "$lib/types";

  // path → status entry, to resolve a file's badge/diff from its changelist.
  const byPath = $derived.by(() => {
    const m = new Map<string, StatusEntry>();
    for (const e of appState.repoStatus?.entries ?? []) m.set(e.path, e);
    return m;
  });

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

  let collapsed = $state(new Set<string>());
  function toggle(id: string) {
    const n = new Set(collapsed);
    n.has(id) ? n.delete(id) : n.add(id);
    collapsed = n;
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

  function doDelete(id: string) {
    if (confirm("Delete this changelist? Its files move to Default.")) deleteChangelist(id);
  }

  // Move a file to another changelist via a right-click menu (HTML5 drag is
  // intercepted by Tauri's file-drop; a menu is reliable for v1).
  let moveMenu = $state<{ x: number; y: number; path: string } | null>(null);
  function openMove(e: MouseEvent, path: string) {
    e.preventDefault();
    moveMenu = { x: e.clientX, y: e.clientY, path };
  }
  function moveTo(targetId: string) {
    if (moveMenu) moveFileToChangelist(moveMenu.path, targetId);
    moveMenu = null;
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
  let dragPath = $state<string | null>(null);
  let ghost = $state<{ x: number; y: number; label: string } | null>(null);
  let dropList = $state<string | null>(null);
  let pending: { path: string; x: number; y: number } | null = null;
  const DRAG_THRESHOLD = 5;

  function groupUnder(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cl]");
    return el?.dataset.cl ?? null;
  }
  function onFilePointerDown(e: PointerEvent, path: string) {
    if (e.button !== 0) return;
    pending = { path, x: e.clientX, y: e.clientY };
  }
  function onWinPointerMove(e: PointerEvent) {
    if (dragPath) {
      ghost = { x: e.clientX, y: e.clientY, label: basename(dragPath) };
      dropList = groupUnder(e.clientX, e.clientY);
      return;
    }
    if (!pending) return;
    const dx = e.clientX - pending.x;
    const dy = e.clientY - pending.y;
    if (dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
      dragPath = pending.path;
      ghost = { x: e.clientX, y: e.clientY, label: basename(pending.path) };
      pending = null;
    }
  }
  function onWinPointerUp(e: PointerEvent) {
    if (dragPath) {
      const target = groupUnder(e.clientX, e.clientY);
      if (target) moveFileToChangelist(dragPath, target);
      dragPath = null;
      ghost = null;
      dropList = null;
    }
    pending = null;
  }
  function basename(p: string): string {
    const i = p.lastIndexOf("/");
    return i < 0 ? p : p.slice(i + 1);
  }
</script>

<svelte:window
  onclick={() => (moveMenu = null)}
  onpointermove={onWinPointerMove}
  onpointerup={onWinPointerUp}
/>

<div class="cl-root">
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
  </div>

  <div class="cl-scroll">
    {#each appState.changelists as cl (cl.id)}
      {@const isActive = cl.id === appState.activeChangelistId}
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
            <span class="cnt">{cl.files.length}</span>
          </button>
          <div class="cl-actions">
            {#if cl.files.length > 0}
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
          {#if cl.files.length === 0}
            <div class="cl-empty">No files{cl.id === DEFAULT_CHANGELIST ? "" : " — drag here"}</div>
          {:else}
            {#each cl.files as path (path)}
              {@const e = byPath.get(path)}
              {#if e}
                {@const cf = entryToChangedFile(e, "unstaged") as ChangedFile}
                <div class="cl-file" class:active={isSel(path)}>
                  <button
                    type="button"
                    class="cl-pick"
                    onclick={() => pick(path)}
                    onpointerdown={(ev) => onFilePointerDown(ev, path)}
                    oncontextmenu={(ev) => openMove(ev, path)}
                    title={cf.old_path
                      ? `${cf.old_path} → ${path}`
                      : `${path} · drag onto a changelist to move`}
                  >
                    <span class="fbadge" data-status={cf.status}>{badge(cf.status)}</span>
                    <span class="fpath">{path}</span>
                  </button>
                </div>
              {/if}
            {/each}
          {/if}
        {/if}
      </div>
    {/each}
  </div>
</div>

{#if moveMenu}
  {@const cur = currentListOf(moveMenu.path)}
  <div class="cl-menu" style="left: {moveMenu.x}px; top: {moveMenu.y}px" role="menu">
    <div class="cl-menu-head">Move to changelist</div>
    {#each appState.changelists as l (l.id)}
      <button
        type="button"
        role="menuitem"
        disabled={l.id === cur}
        onclick={() => moveTo(l.id)}
      >
        {l.id === cur ? "● " : ""}{l.name}
      </button>
    {/each}
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
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .new-cl {
    width: 100%;
    padding: 4px 8px;
    border: 1px dashed var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.85em;
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
</style>
