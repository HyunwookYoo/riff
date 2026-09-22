<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    branchStatus,
    createBranch,
    deleteBranch,
    listRefs,
    renameBranch,
  } from "$lib/git";
  import {
    enterChangesMode,
    loadCurrentBranch,
  } from "$lib/workingCopy";
  import { enterGraphView, selectBranchInGraph } from "$lib/commitHistory";
  import { requestCheckout } from "$lib/checkout";
  import { openRebasePlan, requestRebase } from "$lib/rebase";
  import { requestPush } from "$lib/push";
  import { confirmAction } from "$lib/dialogs";
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
  let changeCount = $state(0); // uncommitted files, for the Working nav badge
  let busy = $state(false);
  // A load runs `git for-each-ref` plus, outside Changes, a ref-only branch
  // read. Both are cheap now, but the watcher can still bump refsRefresh again
  // before one returns, so serialize: one load in flight, later requests fold
  // into a single trailing load (see repoWatch.ts for the same guard).
  let loading = false;
  let queued = false;

  const locals = $derived(branches.filter((b) => b.kind === "local"));
  const remotes = $derived(branches.filter((b) => b.kind === "remote"));
  const tags = $derived(branches.filter((b) => b.kind === "tag"));

  $effect(() => {
    void repoPath;
    void appState.repoStatus;
    void appState.refsRefresh;
    if (!repoPath) {
      branches = [];
      current = null;
      return;
    }
    void load();
  });

  async function load() {
    if (loading) {
      queued = true;
      return;
    }
    const p = repoPath;
    loading = true;
    try {
      // In Changes the sidebar tracks the repo the screen acts on
      // (repoIdx === changesRepoIdx), and loadStatus() has just read exactly
      // this status — running `git status` again here would double the cost
      // for identical data. Everywhere else the sidebar needs the branch and
      // its ahead/behind, which `branchStatus` answers from refs alone: a
      // second full working-tree walk per refresh, in modes that show no file
      // list at all, is what this view used to cost.
      const shared =
        appState.appMode === "changes" ? appState.repoStatus : null;
      const [refs, st] = await Promise.all([
        listRefs(p),
        shared ?? branchStatus(p),
      ]);
      branches = refs;
      // Keep the shared cache (used by the graph badge merge + checkout DWIM)
      // in sync with this freshly-listed set.
      appState.branchesByRepoIdx = {
        ...appState.branchesByRepoIdx,
        [repoIdx]: refs,
      };
      current = st.branch;
      ahead = st.ahead;
      behind = st.behind;
      // Only a full status knows how many files changed. Outside Changes we
      // show the last count read for this same repo rather than walking the
      // tree again for a badge; a different repo gets no number instead of a
      // wrong one.
      changeCount = shared
        ? shared.entries.length
        : repoIdx === appState.changesRepoIdx
          ? (appState.repoStatus?.entries.length ?? 0)
          : 0;
    } catch {
      branches = [];
      current = null;
    } finally {
      loading = false;
      if (queued) {
        queued = false;
        void load();
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

  function checkoutTarget(b: Branch): string {
    // A remote branch DWIMs into a tracking local of the same short name.
    return b.kind === "remote" ? b.name.replace(/^[^/]+\//, "") : b.name;
  }
  // For a remote branch, fast-forward the local tracker to it after switching
  // so a behind local catches up to the remote that was clicked.
  function checkoutFf(b: Branch): string | undefined {
    return b.kind === "remote" ? b.name : undefined;
  }
  function doCheckout(b: Branch) {
    void requestCheckout(repoPath, checkoutTarget(b), checkoutFf(b));
  }
  // Runs the switch directly; if git refuses (local changes in the way), the
  // error banner shows its message instead of blocking the switch upfront.
  function confirmCheckout(b: Branch) {
    void requestCheckout(repoPath, checkoutTarget(b), checkoutFf(b));
  }

  // Single vs double click on a ref row. Double-click checks out; a lone single
  // click reveals the branch's tip in the graph (only while the graph is open).
  // A short timer holds the single-click action so the first click of a
  // double-click doesn't fire it (and flash a diff) before the checkout.
  let clickTimer: ReturnType<typeof setTimeout> | null = null;
  function onRefClick(b: Branch) {
    if (clickTimer !== null) return; // 2nd click of a double — let dblclick win
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (appState.appMode === "history") selectBranchInGraph(b);
    }, 250);
  }
  function onRefDblClick(b: Branch) {
    if (clickTimer !== null) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    confirmCheckout(b);
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
        (await confirmAction(
          `'${b.name}' is not fully merged. Force delete? This discards its unmerged commits.`,
          { title: "Force delete branch" },
        ))
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

  // Name search + pin the checked-out branch to the top of Local.
  let query = $state("");
  function matches(name: string): boolean {
    const q = query.trim().toLowerCase();
    return q === "" || name.toLowerCase().includes(q);
  }
  const filtered = (refs: Branch[]) => refs.filter((b) => matches(b.name));
  const currentLocal = $derived(
    locals.find((b) => b.name === current && matches(b.name)) ?? null,
  );
  const localRows = $derived(
    buildRows(filtered(locals.filter((b) => b.name !== current)), "local"),
  );
  const remoteRows = $derived(buildRows(filtered(remotes), "remote"));
  const tagRows = $derived(buildRows(filtered(tags), "tag"));

  // ── Inline editor (create / rename) ─────────────────────────────────────
  type Editor =
    | { kind: "new"; start: string | null }
    | { kind: "rename"; branch: string };
  let editor = $state<Editor | null>(null);
  let editVal = $state("");
  const editorLabel = $derived(
    editor?.kind === "rename"
      ? "Rename to"
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
  }

  // ── Rebase ───────────────────────────────────────────────────────────────
  // Two ways in, one meaning: the ref you point at is the target the commits
  // land on. A drag names both ends, so dropping A on B replays A; a right-
  // click names only the target, so the menu on B replays the current branch.
  let dragBranch = $state<string | null>(null);
  let dropTarget = $state<string | null>(null);

  function canDrop(ref: Branch): boolean {
    return dragBranch !== null && dragBranch !== ref.name;
  }
  function endDrag() {
    dragBranch = null;
    dropTarget = null;
  }
  function onDrop(ref: Branch) {
    const branch = dragBranch;
    endDrag();
    if (!branch || branch === ref.name) return;
    void requestRebase(repoPath, ref.name, branch);
  }
  function doPush(ref: Branch, force: boolean) {
    menu = null;
    void requestPush(repoPath, ref.name, force);
  }

  function doRebase(ref: Branch, interactive: boolean) {
    menu = null;
    if (!current) return;
    void (interactive
      ? openRebasePlan(repoPath, ref.name, null)
      : requestRebase(repoPath, ref.name, null));
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
    class:droptarget={dropTarget === ref.name}
    style="padding-left: {8 + depth * 14}px"
    draggable={ref.kind === "local"}
    ondragstart={(e) => {
      dragBranch = ref.name;
      // Chromium starts a drag without payload, but setting one keeps the
      // cursor and drop semantics right (and is required by other engines).
      e.dataTransfer?.setData("text/plain", ref.name);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    }}
    ondragend={endDrag}
    ondragover={(e) => {
      if (!canDrop(ref)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      dropTarget = ref.name;
    }}
    ondragleave={() => {
      if (dropTarget === ref.name) dropTarget = null;
    }}
    ondrop={(e) => {
      e.preventDefault();
      onDrop(ref);
    }}
    onclick={() => onRefClick(ref)}
    ondblclick={() => onRefDblClick(ref)}
    oncontextmenu={(e) => openMenu(e, ref)}
    title={dragBranch && canDrop(ref)
      ? `Drop to rebase ${dragBranch} onto ${ref.name}`
      : appState.appMode === "history"
        ? "Click to reveal in graph · double-click to checkout · drag a branch onto another ref to rebase · right-click for actions"
        : "Double-click to checkout · drag a branch onto another ref to rebase · right-click for actions"}
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

  {#if appState.appMode === "changes" || appState.appMode === "history"}
    <nav class="views" aria-label="Working Copy view">
      <button
        type="button"
        class="view"
        class:active={appState.appMode === "changes"}
        onclick={() => void enterChangesMode()}
      >
        <svg
          class="vi"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        <span class="v-label">Working Copy</span>
        {#if changeCount > 0}<span class="v-badge">{changeCount}</span>{/if}
      </button>
      <button
        type="button"
        class="view"
        class:active={appState.appMode === "history"}
        onclick={() => void enterGraphView()}
      >
        <svg
          class="vi"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="5" cy="6" r="2.5" />
          <circle cx="5" cy="18" r="2.5" />
          <path d="M5 8.5v7" />
          <circle cx="17" cy="12" r="2.5" />
          <path d="M5 12h9.5" />
        </svg>
        <span class="v-label">Graph</span>
      </button>
    </nav>
  {/if}

  <div class="search">
    <input
      type="text"
      placeholder="Search branches…"
      bind:value={query}
    />
    {#if query}
      <button
        type="button"
        class="clear"
        aria-label="Clear search"
        onclick={() => (query = "")}
      >
        ×
      </button>
    {/if}
  </div>

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
      {#if currentLocal}
        {@render refRow(currentLocal, currentLocal.name, 0)}
      {/if}
      {#each localRows as row (row.kind === "dir" ? "d:" + row.path : "r:" + row.ref.name)}
        {#if row.kind === "dir"}
          {@render dirRow("local", row.path, row.name, row.depth)}
        {:else}
          {@render refRow(row.ref, row.name, row.depth)}
        {/if}
      {/each}
      {#if !currentLocal && localRows.length === 0}
        <div class="empty">{query ? "No matches" : "No local branches"}</div>
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
    {#if current && ref.name !== current}
      <button type="button" role="menuitem" onclick={() => doRebase(ref, false)}>
        Rebase {current} onto {ref.name}
      </button>
      <button type="button" role="menuitem" onclick={() => doRebase(ref, true)}>
        Rebase {current} onto {ref.name}… (plan)
      </button>
    {/if}
    {#if ref.kind === "local"}
      <button type="button" role="menuitem" onclick={() => doPush(ref, false)}>
        Push
      </button>
      <button type="button" role="menuitem" onclick={() => doPush(ref, true)}>
        Force push (with lease)…
      </button>
      <button
        type="button"
        role="menuitem"
        onclick={() => openEditor({ kind: "rename", branch: ref.name }, ref.name)}
      >
        Rename…
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
  /* Fork-style view nav: Working Copy / Graph. */
  .views {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    border-bottom: 1px solid var(--border);
  }
  .view {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.92em;
    text-align: left;
  }
  .view:hover {
    background: var(--hover);
  }
  .view.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .view .vi {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  .view .v-label {
    flex: 1;
  }
  .view .v-badge {
    flex: 0 0 auto;
    min-width: 18px;
    padding: 0 6px;
    border-radius: 9px;
    background: var(--accent);
    color: #fff;
    font-size: 0.72em;
    font-weight: 700;
    text-align: center;
    line-height: 1.5;
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
  .search {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
  }
  .search input {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    padding: 4px 7px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.82em;
  }
  .search .clear {
    flex: 0 0 auto;
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
    padding: 0 4px;
  }
  .search .clear:hover {
    color: var(--accent);
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
  /* The ref a dragged branch would be rebased onto. */
  .ref.droptarget {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
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
