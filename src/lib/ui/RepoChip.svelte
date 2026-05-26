<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { appState } from "$lib/store.svelte";
  import {
    addManualRepoToWorkspace,
    clearRepoOverride,
    loadMainRepo,
    removeManualRepoFromWorkspace,
    setRepoOverride,
  } from "$lib/workspace";
  import type { RepoEntry } from "$lib/types";

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

  // Per-repo override (§13.3 #9). Track expansion + draft input per repo
  // path so opening/closing the popover doesn't lose typed-but-not-applied
  // text. Keyed by path so reordering repos[] doesn't shuffle drafts.
  let openOverrideFor = $state<string | null>(null);
  let draftStart = $state<Record<string, string>>({});
  let draftTarget = $state<Record<string, string>>({});

  function toggleOverride(repo: RepoEntry) {
    if (openOverrideFor === repo.path) {
      openOverrideFor = null;
      return;
    }
    // Seed draft inputs from the current override (or empty).
    draftStart[repo.path] = repo.override?.startBranch ?? "";
    draftTarget[repo.path] = repo.override?.targetBranch ?? "";
    openOverrideFor = repo.path;
  }

  function applyOverride(repo: RepoEntry, idx: number) {
    const s = (draftStart[repo.path] ?? "").trim();
    const t = (draftTarget[repo.path] ?? "").trim();
    if (!s || !t) return;
    setRepoOverride(idx, s, t);
    openOverrideFor = null;
  }

  function resetOverride(repo: RepoEntry, idx: number) {
    draftStart[repo.path] = "";
    draftTarget[repo.path] = "";
    clearRepoOverride(idx);
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
            {#each appState.repos as r, i (r.path)}
              {@const overrideOpen = openOverrideFor === r.path}
              {@const hasOverride = !!r.override}
              <li>
                <div class="repo-row">
                  <span class="repo-name" title={r.path}>{r.displayName}</span>
                  <span class="repo-kind" data-kind={r.kind}>
                    {kindLabel(r.kind)}
                  </span>
                  {#if hasOverride}
                    <span class="override-dot" title="Branch override active"
                      >●</span
                    >
                  {/if}
                  {#if r.kind !== "main"}
                    <button
                      type="button"
                      class="override-toggle"
                      title={r.kind === "submodule"
                        ? "Override branches (default: gitlink-follow main's start/target)"
                        : "Override branches (default: same as main)"}
                      onclick={() => toggleOverride(r)}
                    >
                      {overrideOpen ? "▾" : "▸"} refs
                    </button>
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
                {#if overrideOpen && r.kind !== "main"}
                  <div class="override-panel">
                    <input
                      type="text"
                      placeholder="start (e.g. main)"
                      bind:value={draftStart[r.path]}
                      onkeydown={(e) =>
                        e.key === "Enter" && applyOverride(r, i)}
                    />
                    <input
                      type="text"
                      placeholder="target (e.g. feature)"
                      bind:value={draftTarget[r.path]}
                      onkeydown={(e) =>
                        e.key === "Enter" && applyOverride(r, i)}
                    />
                    <div class="override-actions">
                      <button
                        type="button"
                        class="override-apply"
                        onclick={() => applyOverride(r, i)}
                      >
                        Apply
                      </button>
                      {#if hasOverride}
                        <button
                          type="button"
                          class="override-clear"
                          onclick={() => resetOverride(r, i)}
                        >
                          Reset to default
                        </button>
                      {/if}
                    </div>
                    <div class="override-hint">
                      {#if r.kind === "submodule"}
                        Default: follow main's gitlink SHAs. Override uses
                        the typed refs inside this submodule directly.
                      {:else}
                        Default: match main's branch names. Override uses
                        the typed refs in this repo.
                      {/if}
                    </div>
                  </div>
                {/if}
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
  .override-toggle {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.75em;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--mono);
  }
  .override-toggle:hover {
    background: var(--hover);
    color: inherit;
  }
  .override-panel {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 10px 8px;
    background: var(--input-bg);
    border-top: 1px solid var(--border);
  }
  .override-panel input {
    width: 100%;
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bar-bg);
    color: inherit;
    font-size: 0.85em;
    font-family: var(--mono);
  }
  .override-actions {
    display: flex;
    gap: 4px;
    margin-top: 2px;
  }
  .override-apply,
  .override-clear {
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bar-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.8em;
  }
  .override-apply {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .override-clear {
    color: var(--muted);
  }
  .override-clear:hover {
    background: var(--hover);
  }
  .override-hint {
    font-size: 0.72em;
    opacity: 0.6;
    line-height: 1.3;
  }
</style>
