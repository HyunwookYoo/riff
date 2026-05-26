<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { appState } from "$lib/store.svelte";
  import { addRecentRepo, listRefs, validateRepo } from "$lib/git";
  import { compare, setMode } from "$lib/compare";
  import { chooseTheme } from "$lib/theme";
  import type { ThemeChoice } from "$lib/types";
  import { buildWorkspace } from "$lib/workspace";
  import BranchModeFields from "./BranchModeFields.svelte";
  import WorkTreeFields from "./WorkTreeFields.svelte";
  import Dropdown from "./Dropdown.svelte";

  let pathInput = $state(appState.repoPath);

  async function loadRepo(path: string) {
    appState.loadingRepo = true;
    appState.error = null;
    // Clear previous repo's compare state — branches/files no longer apply.
    appState.files = [];
    appState.selectedFile = null;
    appState.startBranch = "";
    appState.targetBranch = "";
    // Blame-mode caches/file pin from the previous repo are also stale.
    appState.repoFiles = [];
    appState.blameTarget = null;
    try {
      await validateRepo(path);
      appState.repoPath = path;
      // Multi-root workspace (§13). Discover submodules from .gitmodules and
      // restore any manual repos the user saved for this main. Failures inside
      // buildWorkspace are non-fatal — falls back to [main only].
      const manualPaths = appState.manualReposByMain[path] ?? [];
      appState.repos = await buildWorkspace(path, manualPaths);
      appState.activeRepoIdx = null;
      appState.collapsedRepos = new Set();
      const [branches, recentRepos] = await Promise.all([
        listRefs(path),
        addRecentRepo(path),
      ]);
      appState.branches = branches;
      appState.recentRepos = recentRepos;
      // Working tree mode has no inputs to fill in — load immediately so the
      // user sees their uncommitted changes on repo open.
      if (appState.compareMode === "worktree") {
        void compare();
      }
    } catch (e) {
      appState.error = String(e);
      appState.branches = [];
    } finally {
      appState.loadingRepo = false;
    }
  }

  async function browse() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Git repository",
    });
    if (typeof selected === "string") {
      pathInput = selected;
      await loadRepo(selected);
    }
  }

  function onPathSubmit() {
    if (pathInput && pathInput !== appState.repoPath) {
      loadRepo(pathInput);
    }
  }

  // Direct mode-toggle buttons. Unlike Ctrl+Shift+W (which cycles), these
  // jump to a specific workspace. Entering blame carries selectedFile over
  // so the user lands on its blame, matching the cycle's hand-off behavior.
  function enterCompareMode(target: "branch" | "worktree") {
    if (appState.appMode === "blame") appState.appMode = "compare";
    setMode(target);
  }
  function enterBlameMode() {
    if (appState.selectedFile) {
      // Carry repoIdx so multi-root blame opens in the right repo.
      appState.blameTarget = {
        repoIdx: appState.selectedFile.repoIdx ?? 0,
        path: appState.selectedFile.path,
      };
    }
    appState.appMode = "blame";
  }

  onMount(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length > 0) {
          const p = event.payload.paths[0];
          pathInput = p;
          loadRepo(p);
        }
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  });
</script>

<div class="mode-bar">
  <div class="mode-toggle" role="group" aria-label="Workspace mode">
    <button
      type="button"
      class:active={appState.appMode === "compare" &&
        appState.compareMode === "branch"}
      onclick={() => enterCompareMode("branch")}
      title="Compare two refs"
    >
      Branch
    </button>
    <button
      type="button"
      class:active={appState.appMode === "compare" &&
        appState.compareMode === "worktree"}
      onclick={() => enterCompareMode("worktree")}
      title="Uncommitted changes vs HEAD"
    >
      Working Tree
    </button>
    <button
      type="button"
      class:active={appState.appMode === "blame"}
      onclick={enterBlameMode}
      title="Blame a file"
    >
      Blame
    </button>
  </div>
  <span class="mode-hint">Ctrl+Shift+W to cycle</span>
</div>

<div class="bar">
  <input
    type="text"
    class="path"
    list="recent-repos"
    placeholder="Repository path (drag a folder, or click Browse)"
    bind:value={pathInput}
    onchange={onPathSubmit}
  />
  <datalist id="recent-repos">
    {#each appState.recentRepos as r (r)}
      <option value={r}></option>
    {/each}
  </datalist>
  <button onclick={browse}>Browse…</button>

  {#if appState.appMode === "compare"}
    {#if appState.compareMode === "branch"}
      <BranchModeFields />
    {:else}
      <WorkTreeFields />
    {/if}
  {/if}

  {#if appState.appMode === "compare"}
    <label class="check" title="Ignore whitespace changes (-w)">
      <input type="checkbox" bind:checked={appState.ignoreWhitespace} />
      <span>ws</span>
    </label>
  {/if}

  <Dropdown
    title="Theme"
    value={appState.theme}
    options={[
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ]}
    onchange={(v) => chooseTheme(v as ThemeChoice)}
  />

  {#if appState.appMode === "compare"}
    <button
      class="primary"
      onclick={() => void compare()}
      disabled={appState.loadingFiles || appState.loadingRepo}
    >
      {#if appState.loadingFiles}
        …
      {:else if appState.compareMode === "worktree"}
        Refresh
      {:else}
        Compare
      {/if}
    </button>
  {/if}
</div>

{#if appState.error}
  <div class="error">{appState.error}</div>
{/if}

<style>
  .mode-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .mode-hint {
    font-size: 0.75em;
    opacity: 0.5;
    margin-left: auto;
    font-family: var(--mono);
  }
  .bar {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .path {
    flex: 1 1 auto;
    min-width: 200px;
  }
  .primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .error {
    padding: 6px 10px;
    background: var(--error-bg);
    color: var(--error-fg);
    font-size: 0.85em;
    white-space: pre-wrap;
  }
  input,
  button {
    font-size: 0.9em;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.85em;
    cursor: pointer;
    user-select: none;
  }
  .check input {
    margin: 0;
    cursor: pointer;
  }
  .mode-toggle {
    display: inline-flex;
  }
  .mode-toggle button {
    border-radius: 0;
    font-size: 0.85em;
  }
  .mode-toggle button + button {
    border-left: none;
  }
  .mode-toggle button:first-child {
    border-top-left-radius: 4px;
    border-bottom-left-radius: 4px;
  }
  .mode-toggle button:last-child {
    border-top-right-radius: 4px;
    border-bottom-right-radius: 4px;
  }
  .mode-toggle button.active {
    /* Rider tab-style: accent underline + soft accent fill (same hue family
     * in both themes — avoids the light=white / dark=black inversion that
     * `--input-bg` would cause). */
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--accent);
  }
</style>
