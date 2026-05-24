<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { appState } from "$lib/store.svelte";
  import {
    addRecentRepo,
    diffFiles,
    listRefs,
    setCompareMode,
    validateRepo,
    worktreeFiles,
  } from "$lib/git";
  import { chooseTheme } from "$lib/theme";
  import { detectLanguage } from "$lib/diff/lang";
  import { preloadLanguages } from "$lib/diff/shiki";
  import type { ChangedFile, CompareMode, ThemeChoice } from "$lib/types";
  import BranchModeFields from "./BranchModeFields.svelte";
  import WorkTreeFields from "./WorkTreeFields.svelte";

  let pathInput = $state(appState.repoPath);

  async function loadRepo(path: string) {
    appState.loadingRepo = true;
    appState.error = null;
    // Clear previous repo's compare state — branches/files no longer apply.
    appState.files = [];
    appState.selectedFile = null;
    appState.startBranch = "";
    appState.targetBranch = "";
    try {
      await validateRepo(path);
      appState.repoPath = path;
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

  // Monotonic id so a stale stream from a cancelled compare can't poison the
  // newer one's state. The Rust side also kills its previous child, but events
  // already in flight on the JS bus would otherwise still land.
  let compareSession = 0;

  async function compare() {
    if (!appState.repoPath) {
      appState.error = "no repository selected";
      return;
    }
    if (
      appState.compareMode === "branch" &&
      (!appState.startBranch || !appState.targetBranch)
    ) {
      appState.error = "start and target are required";
      return;
    }
    const session = ++compareSession;
    // Worktree refreshes preserve the user's current selection if it survives;
    // branch compares (different ref pair) reset to the first file.
    const previousPath =
      appState.compareMode === "worktree"
        ? (appState.selectedFile?.path ?? null)
        : null;

    appState.loadingFiles = true;
    appState.error = null;
    appState.files = [];
    appState.selectedFile = null;

    const onFile = (file: ChangedFile) => {
      if (session !== compareSession) return;
      appState.files.push(file);
      if (previousPath) {
        if (file.path === previousPath && !appState.selectedFile) {
          appState.selectedFile = file;
        }
      } else if (!appState.selectedFile) {
        appState.selectedFile = file;
      }
      void preloadLanguages([detectLanguage(file.path)]);
    };

    try {
      if (appState.compareMode === "worktree") {
        await worktreeFiles(
          appState.repoPath,
          appState.ignoreWhitespace,
          onFile,
        );
      } else {
        await diffFiles(
          appState.repoPath,
          appState.startBranch,
          appState.targetBranch,
          appState.mode,
          appState.ignoreWhitespace,
          onFile,
        );
      }
      // Previous selection didn't survive the refresh — fall back to first file.
      if (
        session === compareSession &&
        previousPath &&
        !appState.selectedFile &&
        appState.files.length > 0
      ) {
        appState.selectedFile = appState.files[0];
      }
    } catch (e) {
      if (session === compareSession) {
        appState.error = String(e);
        appState.files = [];
        appState.selectedFile = null;
      }
    } finally {
      if (session === compareSession) {
        appState.loadingFiles = false;
      }
    }
  }

  function setMode(m: CompareMode) {
    if (m === appState.compareMode) return;
    appState.compareMode = m;
    void setCompareMode(m);
    appState.files = [];
    appState.selectedFile = null;
    appState.error = null;
    if (m === "worktree" && appState.repoPath) {
      void compare();
    }
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

  <div class="mode-toggle" role="group" aria-label="Compare mode">
    <button
      type="button"
      class:active={appState.compareMode === "branch"}
      onclick={() => setMode("branch")}
      title="Compare two refs"
    >
      Branch
    </button>
    <button
      type="button"
      class:active={appState.compareMode === "worktree"}
      onclick={() => setMode("worktree")}
      title="Uncommitted changes vs HEAD (Ctrl+Shift+W)"
    >
      Working Tree
    </button>
  </div>

  {#if appState.compareMode === "branch"}
    <BranchModeFields />
  {:else}
    <WorkTreeFields />
  {/if}

  <label class="check" title="Ignore whitespace changes (-w)">
    <input type="checkbox" bind:checked={appState.ignoreWhitespace} />
    <span>ws</span>
  </label>

  <select
    title="Theme"
    value={appState.theme}
    onchange={(e) =>
      chooseTheme((e.currentTarget as HTMLSelectElement).value as ThemeChoice)}
  >
    <option value="system">System</option>
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </select>

  <button
    class="primary"
    onclick={compare}
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
</div>

{#if appState.error}
  <div class="error">{appState.error}</div>
{/if}

<style>
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
  select,
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
  .mode-toggle button:first-child {
    border-top-left-radius: 4px;
    border-bottom-left-radius: 4px;
  }
  .mode-toggle button:last-child {
    border-top-right-radius: 4px;
    border-bottom-right-radius: 4px;
    border-left: none;
  }
  .mode-toggle button.active {
    background: var(--selected);
    border-color: var(--accent);
  }
</style>
