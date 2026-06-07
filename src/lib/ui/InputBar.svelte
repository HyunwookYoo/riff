<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { appState } from "$lib/store.svelte";
  import { compare, setMode } from "$lib/compare";
  import {
    enterGraphView,
    restoreCompareContext,
    setHistoryRef,
  } from "$lib/commitHistory";
  import { enterChangesMode } from "$lib/sourceControl";
  import { loadBranchesFor } from "$lib/workspace";
  import { chooseTheme } from "$lib/theme";
  import type { ThemeChoice } from "$lib/types";
  import { loadMainRepo } from "$lib/workspace";
  import BranchModeFields from "./BranchModeFields.svelte";
  import BranchPicker from "./BranchPicker.svelte";
  import WorkTreeFields from "./WorkTreeFields.svelte";
  import Dropdown from "./Dropdown.svelte";
  import RepoChip from "./RepoChip.svelte";
  import BranchChip from "./BranchChip.svelte";
  import UnrealSettings from "./UnrealSettings.svelte";

  // Direct mode-toggle buttons. Unlike Ctrl+Shift+W (which cycles), these
  // jump to a specific workspace. Entering blame carries selectedFile over
  // so the user lands on its blame, matching the cycle's hand-off behavior.
  function enterCompareMode(target: "branch" | "worktree") {
    if (appState.appMode !== "compare") {
      // Leaving history reuses start/target (+ overrides + focus) for
      // parent..commit — put the user's own context back before re-comparing.
      restoreCompareContext();
      appState.appMode = "compare";
    }
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

  // Branches for the currently browsed repo. idx 0 (main) is seeded on repo
  // load; non-main repos lazy-load below.
  const historyBranches = $derived(
    appState.branchesByRepoIdx[appState.historyRepoIdx] ?? [],
  );
  $effect(() => {
    if (appState.appMode === "history") {
      void loadBranchesFor(appState.historyRepoIdx);
    }
  });

  onMount(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length > 0) {
          void loadMainRepo(event.payload.paths[0]);
        }
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  });
</script>

<div class="mode-bar">
  <RepoChip />
  <div class="mode-toggle" role="group" aria-label="Workspace mode">
    <button
      type="button"
      class:active={appState.appMode === "changes" ||
        appState.appMode === "history"}
      onclick={() => void enterChangesMode()}
      title="Source control — stage, commit, and the commit graph"
    >
      Changes
    </button>
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
      class:active={appState.appMode === "blame"}
      onclick={enterBlameMode}
      title="Blame a file"
    >
      Blame
    </button>
  </div>
  <BranchChip />
  <span class="mode-hint">Ctrl+Shift+W to cycle</span>
</div>

<div class="bar">
  {#if appState.appMode === "changes" || appState.appMode === "history"}
    <div class="subtoggle" role="group" aria-label="Source control view">
      <button
        type="button"
        class:active={appState.appMode === "changes"}
        onclick={() => void enterChangesMode()}
        title="Working tree — stage & commit"
      >
        Working
      </button>
      <button
        type="button"
        class:active={appState.appMode === "history"}
        onclick={() => void enterGraphView()}
        title="Commit graph"
      >
        Graph
      </button>
    </div>
  {/if}

  {#if appState.appMode === "compare"}
    {#if appState.compareMode === "branch"}
      <BranchModeFields />
    {:else}
      <WorkTreeFields />
    {/if}
  {/if}

  {#if appState.appMode === "history"}
    <span class="hist-label">Showing</span>
    <BranchPicker
      value={appState.historyRef}
      options={historyBranches}
      placeholder="All branches"
      onchange={setHistoryRef}
      title="Limit the graph to one branch / tag / commit (empty = all branches)"
    />
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

  <UnrealSettings />

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
  .hist-label {
    font-size: 0.85em;
    color: var(--muted);
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
  .subtoggle {
    display: inline-flex;
  }
  .subtoggle button {
    border-radius: 0;
    font-size: 0.82em;
    padding: 3px 12px;
  }
  .subtoggle button:first-child {
    border-top-left-radius: 4px;
    border-bottom-left-radius: 4px;
  }
  .subtoggle button:last-child {
    border-top-right-radius: 4px;
    border-bottom-right-radius: 4px;
    border-left: none;
  }
  .subtoggle button.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--accent);
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
