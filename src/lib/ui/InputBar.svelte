<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { appState } from "$lib/store.svelte";
  import {
    addRecentRepo,
    diffFiles,
    listRefs,
    validateRepo,
  } from "$lib/git";
  import { chooseTheme } from "$lib/theme";
  import { detectLanguage } from "$lib/diff/lang";
  import { preloadLanguages } from "$lib/diff/shiki";
  import type { ThemeChoice } from "$lib/types";

  let pathInput = $state(appState.repoPath);

  async function loadRepo(path: string) {
    appState.loading = true;
    appState.error = null;
    try {
      await validateRepo(path);
      appState.repoPath = path;
      appState.branches = await listRefs(path);
      appState.recentRepos = await addRecentRepo(path);
    } catch (e) {
      appState.error = String(e);
      appState.branches = [];
    } finally {
      appState.loading = false;
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

  async function compare() {
    if (!appState.repoPath || !appState.startBranch || !appState.targetBranch) {
      appState.error = "repo, start, and target are required";
      return;
    }
    appState.loading = true;
    appState.error = null;
    try {
      appState.files = await diffFiles(
        appState.repoPath,
        appState.startBranch,
        appState.targetBranch,
        appState.mode,
        appState.ignoreWhitespace,
      );
      appState.selectedFile = appState.files[0] ?? null;
      void preloadLanguages(
        appState.files.map((f) => detectLanguage(f.path)),
      );
    } catch (e) {
      appState.error = String(e);
      appState.files = [];
      appState.selectedFile = null;
    } finally {
      appState.loading = false;
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

  <input
    type="text"
    class="ref"
    list="branch-list"
    placeholder="start (branch / commit / tag)"
    bind:value={appState.startBranch}
  />
  <span class="sep">→</span>
  <input
    type="text"
    class="ref"
    list="branch-list"
    placeholder="target"
    bind:value={appState.targetBranch}
  />
  <datalist id="branch-list">
    {#each appState.branches as b (b.name + b.kind)}
      <option value={b.name}>{b.kind}</option>
    {/each}
  </datalist>

  <select bind:value={appState.mode} title="Diff mode">
    <option value="three-dot">3-dot (...)</option>
    <option value="two-dot">2-dot (..)</option>
  </select>

  <label class="check" title="Ignore whitespace changes (-w)">
    <input type="checkbox" bind:checked={appState.ignoreWhitespace} />
    <span>ws</span>
  </label>

  <select
    title="Theme"
    value={appState.theme}
    onchange={(e) => chooseTheme((e.currentTarget as HTMLSelectElement).value as ThemeChoice)}
  >
    <option value="system">System</option>
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </select>

  <button class="primary" onclick={compare} disabled={appState.loading}>
    {appState.loading ? "…" : "Compare"}
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
  .ref {
    width: 180px;
  }
  .sep {
    opacity: 0.6;
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
</style>
