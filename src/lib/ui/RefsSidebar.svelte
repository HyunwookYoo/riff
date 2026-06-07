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
  import { loadCurrentBranch } from "$lib/sourceControl";
  import RefIcon from "./RefIcon.svelte";
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
      void loadCurrentBranch();
    }
  }

  function doCheckout(b: Branch) {
    const target =
      b.kind === "remote" ? b.name.replace(/^[^/]+\//, "") : b.name;
    void run(checkout(repoPath, target));
  }

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
      void loadCurrentBranch();
    }
  }

  // ── Tree (collapse by "/") ──────────────────────────────────────────────
  type Row =
    | { kind: "dir"; name: string; path: string; depth: number }
    | { kind: "ref"; ref: Branch; name: string; depth: number };

  // Collapsed dirs keyed `<section>:<dirPath>`.
  let collapsedDirs = $state(new Set<string>());
  function toggleDir(section: string, path: string) {
    const key = section + ":" + path;
    const next = new Set(collapsedDirs);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedDirs = next;
  }

  // Flatten a section's refs into rows, nesting by "/" and honoring collapse.
  function buildRows(refs: Branch[], section: string): Row[] {
    interface Dir {
      children: Map<string, Dir>;
      leaves: { ref: Branch; leaf: string }[];
    }
    const root: Dir = { children: new Map(), leaves: [] };
    for (const ref of refs) {
      const parts = ref.name.split("/");
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let next = cur.children.get(parts[i]);
        if (!next) {
          next = { children: new Map(), leaves: [] };
          cur.children.set(parts[i], next);
        }
        cur = next;
      }
      cur.leaves.push({ ref, leaf: parts[parts.length - 1] });
    }
    const out: Row[] = [];
    const walk = (dir: Dir, prefix: string, depth: number) => {
      for (const name of [...dir.children.keys()].sort()) {
        const path = prefix ? prefix + "/" + name : name;
        out.push({ kind: "dir", name, path, depth });
        if (!collapsedDirs.has(section + ":" + path)) {
          walk(dir.children.get(name)!, path, depth + 1);
        }
      }
      for (const { ref, leaf } of [...dir.leaves].sort((a, b) =>
        a.leaf.localeCompare(b.leaf),
      )) {
        out.push({ kind: "ref", ref, name: leaf, depth });
      }
    };
    walk(root, "", 0);
    return out;
  }

  const localRows = $derived(buildRows(locals, "local"));
  const remoteRows = $derived(buildRows(remotes, "remote"));
  const tagRows = $derived(buildRows(tags, "tag"));

  // ── Inline editor (create / rename / set-upstream) ──────────────────────
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

  // ── Context menu ────────────────────────────────────────────────────────
  let menu = $state<{ x: number; y: number; ref: Branch } | null>(null);
  function openMenu(e: MouseEvent, ref: Branch) {
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, ref };
  }

  // ── Width resize ────────────────────────────────────────────────────────
  let asideEl = $state<HTMLElement | null>(null);
  let resizing = $state(false);
  function onResizeStart(e: PointerEvent) {
    if (e.button !== 0 || !asideEl) return;
    e.preventDefault();
    resizing = true;
    const left = asideEl.getBoundingClientRect().left;
    const onMove = (ev: PointerEvent) => {
      appState.sidebarWidth = Math.min(500, Math.max(160, ev.clientX - left));
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

<svelte:window onclick={() => (menu = null)} />

{#snippet refRow(ref: Branch, name: string, depth: number)}
  <button
    type="button"
    class="ref"
    class:current={ref.name === current}
    style="padding-left: {8 + depth * 14}px"
    ondblclick={() => doCheckout(ref)}
    oncontextmenu={(e) => openMenu(e, ref)}
    title="Double-click to checkout · right-click for actions"
  >
    <RefIcon kind={ref.kind} />
    <span class="name">{name}</span>
    {#if ref.name === current && (ahead || behind)}
      <span class="ab">
        {#if ahead}↑{ahead}{/if}{#if behind}↓{behind}{/if}
      </span>
    {/if}
  </button>
{/snippet}

{#snippet dirRow(section: string, path: string, name: string, depth: number)}
  <button
    type="button"
    class="dir"
    style="padding-left: {8 + depth * 14}px"
    onclick={() => toggleDir(section, path)}
  >
    <span class="caret" aria-hidden="true">
      {collapsedDirs.has(section + ":" + path) ? "▸" : "▾"}
    </span>
    <RefIcon kind="folder" />
    <span class="dir-name">{name}</span>
  </button>
{/snippet}

<aside
  class="refs"
  class:resizing
  bind:this={asideEl}
  style="flex-basis: {appState.sidebarWidth}px;"
>
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
        <input
          bind:value={editVal}
          autofocus
          onkeydown={(e) => e.key === "Escape" && (editor = null)}
        />
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
      {#each localRows as row (row.kind === "dir" ? "d:" + row.path : "r:" + row.ref.name)}
        {#if row.kind === "dir"}
          {@render dirRow("local", row.path, row.name, row.depth)}
        {:else}
          {@render refRow(row.ref, row.name, row.depth)}
        {/if}
      {/each}
      {#if localRows.length === 0}
        <div class="empty">No local branches</div>
      {/if}
    </section>

    {#if remotes.length}
      <section>
        <div class="sec-head"><span>Remotes</span></div>
        {#each remoteRows as row (row.kind === "dir" ? "d:" + row.path : "r:" + row.ref.name)}
          {#if row.kind === "dir"}
            {@render dirRow("remote", row.path, row.name, row.depth)}
          {:else}
            {@render refRow(row.ref, row.name, row.depth)}
          {/if}
        {/each}
      </section>
    {/if}

    {#if tags.length}
      <section>
        <div class="sec-head"><span>Tags</span></div>
        {#each tagRows as row (row.kind === "dir" ? "d:" + row.path : "r:" + row.ref.name)}
          {#if row.kind === "dir"}
            {@render dirRow("tag", row.path, row.name, row.depth)}
          {:else}
            {@render refRow(row.ref, row.name, row.depth)}
          {/if}
        {/each}
      </section>
    {/if}
  </div>

  <div
    class="resizer"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    onpointerdown={onResizeStart}
  ></div>
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
    position: relative;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    border-right: 1px solid var(--border);
    background: var(--sidebar-bg, var(--bar-bg));
    overflow: hidden;
  }
  .refs.resizing {
    user-select: none;
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
  .dir {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 4px 10px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-size: 0.84em;
    user-select: none;
  }
  .dir:hover {
    background: var(--hover);
  }
  .dir .caret {
    width: 10px;
    flex-shrink: 0;
    opacity: 0.6;
    font-size: 0.8em;
  }
  .dir .dir-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.85;
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
    background: var(--accent-soft);
    box-shadow: inset 2px 0 var(--accent);
  }
  .ref .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .resizer {
    position: absolute;
    top: 0;
    right: 0;
    width: 7px;
    height: 100%;
    transform: translateX(3px);
    cursor: col-resize;
    z-index: 6;
    background: transparent;
  }
  .resizer::after {
    content: "";
    position: absolute;
    top: 0;
    left: 3px;
    width: 1px;
    height: 100%;
    background: transparent;
    transition: background 0.1s ease;
  }
  .resizer:hover::after,
  .refs.resizing .resizer::after {
    background: var(--accent);
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
