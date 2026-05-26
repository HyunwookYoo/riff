<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { appState } from "$lib/store.svelte";
  import {
    addManualRepoToWorkspace,
    loadMainRepo,
    removeManualRepoFromWorkspace,
  } from "$lib/workspace";
  import { setWorkspaceLayout } from "$lib/git";
  import type { RepoEntry, WorkspaceLayout } from "$lib/types";

  let open_ = $state(false);
  let filter = $state("");
  let chipEl: HTMLDivElement;
  let searchInputEl: HTMLInputElement | undefined = $state();

  // Filter recents against the typed query. Empty query shows everything.
  const filteredRecents = $derived.by<string[]>(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return appState.recentRepos;
    return appState.recentRepos.filter((p) => p.toLowerCase().includes(q));
  });

  function basename(p: string): string {
    const trimmed = p.replace(/[\\/]+$/, "");
    const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }

  function chipLabel(): string {
    const main = appState.repos[0];
    if (main) return main.displayName;
    if (appState.repoPath) return basename(appState.repoPath);
    return "Open repo…";
  }

  function togglePopover() {
    open_ = !open_;
    if (open_) {
      filter = "";
      // Defer focus so the input exists in the DOM.
      queueMicrotask(() => searchInputEl?.focus());
    }
  }

  function closePopover() {
    open_ = false;
  }

  async function pickRecent(path: string) {
    closePopover();
    await loadMainRepo(path);
  }

  async function browseAndOpen() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Git repository",
    });
    if (typeof selected === "string") {
      closePopover();
      await loadMainRepo(selected);
    }
  }

  async function browseAndAddManual() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Add repo to workspace",
    });
    if (typeof selected === "string") {
      await addManualRepoToWorkspace(selected);
    }
  }

  async function onSearchKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      closePopover();
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      const first = filteredRecents[0];
      if (first) {
        e.preventDefault();
        await pickRecent(first);
      }
    }
  }

  // Click-outside dismiss. Captures clicks anywhere outside the chip/popover
  // wrapper.
  function onWindowMouseDown(e: MouseEvent) {
    if (!open_) return;
    const target = e.target as Node | null;
    if (chipEl && target && !chipEl.contains(target)) {
      closePopover();
    }
  }

  $effect(() => {
    if (open_) {
      window.addEventListener("mousedown", onWindowMouseDown);
      return () => window.removeEventListener("mousedown", onWindowMouseDown);
    }
  });

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

  // §14 Step 2: pick a layout. Step 9 wires the mid-session transition
  // (§14.5 #15-16): Unified → Tabs activates the tab containing the currently
  // selected file (or main when nothing is selected). Tabs → Unified releases
  // Focus so the user sees the full multi-root view again. selectedFile,
  // history, blame state are preserved either direction.
  async function pickLayout(layout: WorkspaceLayout) {
    if (appState.workspaceLayout === layout) return;
    if (layout === "tabs") {
      appState.activeRepoIdx =
        appState.repos.length === 0
          ? null
          : (appState.selectedFile?.repoIdx ?? 0);
    } else {
      appState.activeRepoIdx = null;
    }
    appState.workspaceLayout = layout;
    try {
      await setWorkspaceLayout(layout);
    } catch {
      // Persistence failure is non-fatal — state stays for this session.
    }
  }
</script>

<div class="chip-wrap" bind:this={chipEl}>
  <button
    type="button"
    class="chip"
    class:open={open_}
    onclick={togglePopover}
    title={appState.repoPath || "No repo open"}
  >
    <svg
      class="icon"
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
    <span class="label">{chipLabel()}</span>
    {#if appState.repos.length > 1}
      <span class="badge-extra" title="{appState.repos.length} repos in workspace">
        +{appState.repos.length - 1}
      </span>
    {/if}
    <span class="caret">▾</span>
  </button>

  {#if open_}
    <div class="popover" role="dialog">
      <div class="search">
        <input
          type="search"
          bind:this={searchInputEl}
          bind:value={filter}
          placeholder="Type to filter recents…"
          onkeydown={onSearchKeyDown}
          spellcheck="false"
        />
      </div>

      <div class="section">
        <div class="section-title">Recent</div>
        {#if filteredRecents.length === 0}
          <div class="empty">
            {filter ? "No recents match." : "No recent repos yet."}
          </div>
        {:else}
          <ul>
            {#each filteredRecents as r (r)}
              <li>
                <button
                  type="button"
                  class="recent"
                  class:active={r === appState.repoPath}
                  onclick={() => pickRecent(r)}
                  title={r}
                >
                  <span class="recent-name">{basename(r)}</span>
                  <span class="recent-path">{r}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="section">
        <button type="button" class="action" onclick={browseAndOpen}>
          📂 Browse folder…
        </button>
      </div>

      {#if appState.repos.length > 0}
        <div class="section">
          <div class="section-title">Workspace repos</div>
          <ul class="repos">
            {#each appState.repos as r (r.path)}
              <li>
                <div class="repo-row">
                  <span class="repo-name" title={r.path}>{r.displayName}</span>
                  <span class="repo-kind" data-kind={r.kind}>
                    {kindLabel(r.kind)}
                  </span>
                  {#if r.override}
                    <span class="override-dot" title="Branch override active"
                      >●</span
                    >
                  {/if}
                  {#if r.kind === "manual"}
                    <button
                      type="button"
                      class="remove"
                      title="Remove from workspace"
                      onclick={() => void removeManualRepoFromWorkspace(r.path)}
                    >
                      ×
                    </button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
          {#if appState.repoPath}
            <button type="button" class="action" onclick={browseAndAddManual}>
              + Add manual repo
            </button>
          {/if}
        </div>
      {/if}

      <div class="section">
        <div class="section-title">Layout</div>
        <div class="layout-toggle" role="group" aria-label="Workspace layout">
          <button
            type="button"
            class="seg"
            class:active={appState.workspaceLayout === "unified"}
            onclick={() => void pickLayout("unified")}
            title="All repos in one grouped list with Focus toggle"
          >
            Unified
          </button>
          <button
            type="button"
            class="seg"
            class:active={appState.workspaceLayout === "tabs"}
            onclick={() => void pickLayout("tabs")}
            title="Fork-style tab bar — one repo at a time"
          >
            Tabs
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .chip-wrap {
    position: relative;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.85em;
    max-width: 240px;
    min-width: 120px;
  }
  .chip:hover {
    background: var(--hover);
  }
  .chip.open {
    border-color: var(--accent);
  }
  .chip .icon {
    width: 14px;
    height: 14px;
    opacity: 0.7;
    flex-shrink: 0;
  }
  .chip .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    font-weight: 500;
  }
  .chip .badge-extra {
    font-size: 0.75em;
    padding: 1px 5px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }
  .chip .caret {
    opacity: 0.5;
    font-size: 0.75em;
    flex-shrink: 0;
  }
  .popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 50;
    width: 360px;
    max-height: 480px;
    overflow-y: auto;
    background: var(--bar-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .search input {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.9em;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .section + .section {
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .section-title {
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.6;
    font-weight: 600;
    padding: 0 4px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .empty {
    padding: 6px 8px;
    opacity: 0.6;
    font-size: 0.85em;
  }
  .recent {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    padding: 4px 8px;
    cursor: pointer;
    text-align: left;
    border-radius: 3px;
  }
  .recent:hover {
    background: var(--hover);
  }
  .recent.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .recent .recent-name {
    font-weight: 500;
    font-size: 0.9em;
  }
  .recent .recent-path {
    font-family: var(--mono);
    font-size: 0.75em;
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .action {
    text-align: left;
    background: transparent;
    border: none;
    color: inherit;
    padding: 6px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.88em;
  }
  .action:hover {
    background: var(--hover);
  }
  .repos .repo-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    font-size: 0.85em;
  }
  .repos .repo-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
  }
  .repos .repo-kind {
    font-size: 0.72em;
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--input-bg);
    color: var(--muted);
    border: 1px solid var(--border);
  }
  .repos .repo-kind[data-kind="submodule"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }
  .repos .remove {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1em;
    padding: 0 4px;
    border-radius: 3px;
  }
  .repos .remove:hover {
    background: var(--error-bg);
    color: var(--error-fg);
  }
  .override-dot {
    color: var(--accent);
    font-size: 0.7em;
  }
  .layout-toggle {
    display: flex;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    margin: 0 4px;
  }
  .layout-toggle .seg {
    flex: 1;
    background: transparent;
    color: inherit;
    border: none;
    padding: 4px 8px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .layout-toggle .seg:hover {
    background: var(--hover);
  }
  .layout-toggle .seg.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .layout-toggle .seg + .seg {
    border-left: 1px solid var(--border);
  }
</style>
