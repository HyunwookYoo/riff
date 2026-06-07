<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    checkout,
    createBranch,
    deleteBranch,
    listRefs,
    renameBranch,
    setUpstream,
    status,
  } from "$lib/git";
  import type { Branch } from "$lib/types";

  // The sidebar reflects the repo the current mode is acting on: the Changes /
  // History repo tab, or the compare Focus (main when none). Branch ops then
  // target that repo — including submodules.
  const repoIdx = $derived(
    appState.appMode === "changes"
      ? appState.changesRepoIdx
      : appState.appMode === "history"
        ? appState.historyRepoIdx
        : (appState.activeRepoIdx ?? 0),
  );
  const repoPath = $derived(appState.repos[repoIdx]?.path ?? appState.repoPath);
  const repoName = $derived(appState.repos[repoIdx]?.displayName || "Branches");

  let branches = $state<Branch[]>([]);
  let current = $state<string | null>(null);
  let ahead = $state(0);
  let behind = $state(0);
  let busy = $state(false);
  let session = 0;

  const locals = $derived(branches.filter((b) => b.kind === "local"));
  const remotes = $derived(branches.filter((b) => b.kind === "remote"));
  const tags = $derived(branches.filter((b) => b.kind === "tag"));

  $effect(() => {
    void repoPath;
    // Re-list after commits / stage ops change refs or ahead/behind.
    void appState.repoStatus;
    if (!repoPath) {
      branches = [];
      current = null;
      return;
    }
    void load();
  });

  async function load() {
    const s = ++session;
    const p = repoPath;
    try {
      const [refs, st] = await Promise.all([listRefs(p), status(p)]);
      if (s !== session) return;
      branches = refs;
      current = st.branch;
      ahead = st.ahead;
      behind = st.behind;
    } catch {
      if (s === session) {
        branches = [];
        current = null;
      }
    }
  }

  async function run(op: Promise<void>) {
    if (busy) return;
    busy = true;
    try {
      await op;
    } catch (e) {
      appState.error = String(e);
    } finally {
      busy = false;
      await load();
    }
  }

  function doCheckout(b: Branch) {
    // A remote branch DWIMs into a tracking local of the same short name.
    const target =
      b.kind === "remote" ? b.name.replace(/^[^/]+\//, "") : b.name;
    void run(checkout(repoPath, target));
  }

  // Safe delete (-d); on "not fully merged" offer an explicit force (-D).
  async function doDelete(b: Branch) {
    if (busy) return;
    busy = true;
    try {
      await deleteBranch(repoPath, b.name, false);
    } catch (e) {
      const msg = String(e);
      if (
        /not fully merged|not merged/i.test(msg) &&
        confirm(
          `'${b.name}' is not fully merged. Force delete? This discards its unmerged commits.`,
        )
      ) {
        try {
          await deleteBranch(repoPath, b.name, true);
        } catch (e2) {
          appState.error = String(e2);
        }
      } else {
        appState.error = msg;
      }
    } finally {
      busy = false;
      await load();
    }
  }

  // Inline editor for create / rename / set-upstream — avoids native prompt
  // (unreliable in WebView2).
  type Editor =
    | { kind: "new"; start: string | null }
    | { kind: "rename"; branch: string }
    | { kind: "upstream"; branch: string };
  let editor = $state<Editor | null>(null);
  let editVal = $state("");
  const editorLabel = $derived(
    editor?.kind === "rename"
      ? "Rename to"
      : editor?.kind === "upstream"
        ? "Upstream"
        : editor?.kind === "new" && editor.start
          ? `New branch from ${editor.start}`
          : "New branch",
  );

  function openEditor(ed: Editor, initial: string) {
    menu = null;
    editor = ed;
    editVal = initial;
  }
  function submitEditor(e: Event) {
    e.preventDefault();
    const ed = editor;
    const v = editVal.trim();
    editor = null;
    if (!ed || !v) return;
    if (ed.kind === "new") void run(createBranch(repoPath, v, ed.start, true));
    else if (ed.kind === "rename") void run(renameBranch(repoPath, ed.branch, v));
    else void run(setUpstream(repoPath, ed.branch, v));
  }

  // Right-click context menu.
  let menu = $state<{ x: number; y: number; ref: Branch } | null>(null);
  function openMenu(e: MouseEvent, ref: Branch) {
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, ref };
  }
</script>

<svelte:window onclick={() => (menu = null)} />

<aside class="refs">
  <header>
    <span class="title" title={repoPath}>{repoName}</span>
    <button
      type="button"
      class="close"
      title="Hide sidebar (Ctrl+B)"
      aria-label="Hide sidebar"
      onclick={() => (appState.sidebarOpen = false)}
    >
      ×
    </button>
  </header>

  {#if editor}
    <form class="editor" onsubmit={submitEditor}>
      <label>
        <span class="editor-label">{editorLabel}</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input bind:value={editVal} autofocus onkeydown={(e) => e.key === "Escape" && (editor = null)} />
      </label>
    </form>
  {/if}

  <div class="scroll">
    <section>
      <div class="sec-head">
        <span>Local</span>
        <button
          type="button"
          class="new"
          title="New branch"
          aria-label="New branch"
          onclick={() => openEditor({ kind: "new", start: null }, "")}
        >
          ＋
        </button>
      </div>
      {#each locals as b (b.name)}
        <button
          type="button"
          class="ref"
          class:current={b.name === current}
          ondblclick={() => doCheckout(b)}
          oncontextmenu={(e) => openMenu(e, b)}
          title="Double-click to checkout · right-click for actions"
        >
          <span class="dot">{b.name === current ? "●" : ""}</span>
          <span class="name">{b.name}</span>
          {#if b.name === current && (ahead || behind)}
            <span class="ab">
              {#if ahead}↑{ahead}{/if}{#if behind}↓{behind}{/if}
            </span>
          {/if}
        </button>
      {/each}
      {#if locals.length === 0}
        <div class="empty">No local branches</div>
      {/if}
    </section>

    {#if remotes.length}
      <section>
        <div class="sec-head"><span>Remotes</span></div>
        {#each remotes as b (b.name)}
          <button
            type="button"
            class="ref"
            ondblclick={() => doCheckout(b)}
            oncontextmenu={(e) => openMenu(e, b)}
            title="Double-click to checkout · right-click for actions"
          >
            <span class="dot"></span>
            <span class="name">{b.name}</span>
          </button>
        {/each}
      </section>
    {/if}

    {#if tags.length}
      <section>
        <div class="sec-head"><span>Tags</span></div>
        {#each tags as b (b.name)}
          <button
            type="button"
            class="ref"
            ondblclick={() => doCheckout(b)}
            oncontextmenu={(e) => openMenu(e, b)}
            title="Double-click to checkout · right-click for actions"
          >
            <span class="dot"></span>
            <span class="name">{b.name}</span>
          </button>
        {/each}
      </section>
    {/if}
  </div>
</aside>

{#if menu}
  {@const ref = menu.ref}
  <div class="ctxmenu" style="left: {menu.x}px; top: {menu.y}px" role="menu">
    {#if ref.name !== current}
      <button type="button" role="menuitem" onclick={() => doCheckout(ref)}>
        Checkout
      </button>
    {/if}
    <button
      type="button"
      role="menuitem"
      onclick={() => openEditor({ kind: "new", start: ref.name }, "")}
    >
      New branch from here…
    </button>
    {#if ref.kind === "local"}
      <button
        type="button"
        role="menuitem"
        onclick={() => openEditor({ kind: "rename", branch: ref.name }, ref.name)}
      >
        Rename…
      </button>
      <button
        type="button"
        role="menuitem"
        onclick={() =>
          openEditor({ kind: "upstream", branch: ref.name }, `origin/${ref.name}`)}
      >
        Set upstream…
      </button>
      {#if ref.name !== current}
        <button
          type="button"
          role="menuitem"
          class="danger"
          onclick={() => doDelete(ref)}
        >
          Delete
        </button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .refs {
    flex: 0 0 220px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--sidebar-bg, var(--bar-bg));
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 0.85em;
    font-weight: 600;
  }
  header .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
  }
  header .close {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
    padding: 0 4px;
  }
  header .close:hover {
    color: var(--accent);
  }
  .editor {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
  }
  .editor label {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .editor-label {
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .editor input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.82em;
    font-family: var(--mono);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  section {
    border-bottom: 1px solid var(--border);
  }
  .sec-head {
    display: flex;
    align-items: center;
    padding: 5px 10px;
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .sec-head .new {
    margin-left: auto;
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1em;
    line-height: 1;
    padding: 0 2px;
  }
  .sec-head .new:hover {
    color: var(--accent);
  }
  .ref {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 10px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-size: 0.85em;
    font-family: var(--mono);
  }
  .ref:hover {
    background: var(--hover);
  }
  .ref.current {
    color: var(--accent);
    font-weight: 600;
  }
  .ref .dot {
    width: 0.8em;
    flex-shrink: 0;
    color: var(--accent);
    font-size: 0.7em;
  }
  .ref .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    flex: 1;
  }
  .ref .ab {
    flex-shrink: 0;
    font-size: 0.8em;
    opacity: 0.8;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    padding: 6px 12px;
    color: var(--muted);
    font-size: 0.8em;
  }
  .ctxmenu {
    position: fixed;
    z-index: 100;
    min-width: 170px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .ctxmenu button {
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 5px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .ctxmenu button:hover {
    background: var(--hover);
  }
  .ctxmenu button.danger {
    color: var(--error-fg, #f85149);
  }
</style>
