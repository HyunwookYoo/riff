<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { appState } from "$lib/store.svelte";
  import { compare, setMode } from "$lib/compare";
  import {
    enterHistoryMode,
    restoreCompareContext,
    setHistoryRef,
    setHistoryRepo,
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

  // History-mode repo picker: list every workspace repo (main + submodules).
  const historyRepoOptions = $derived(
    appState.repos.map((r, i) => ({
      value: String(i),
      label: r.displayName || (i === 0 ? "main" : `repo ${i}`),
    })),
  );
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
      class:active={appState.appMode === "changes"}
      onclick={() => void enterChangesMode()}
      title="Stage and commit changes"
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
      class:active={appState.appMode === "compare" &&
        appState.compareMode === "worktree"}
      onclick={() => enterCompareMode("worktree")}
      title="Uncommitted changes vs HEAD"
    >
      Working Tree
    </button>
    <button
      type="button"
      class:active={appState.appMode === "history"}
      onclick={() => void enterHistoryMode()}
      title="Browse commit history"
    >
      History
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
  {#if appState.appMode === "compare"}
    {#if appState.compareMode === "branch"}
      <BranchModeFields />
    {:else}
      <WorkTreeFields />
    {/if}
  {/if}

  {#if appState.appMode === "history"}
    {#if appState.repos.length > 1}
      <Dropdown
        title="Repository to browse"
        align="left"
        value={String(appState.historyRepoIdx)}
        options={historyRepoOptions}
        onchange={(v) => setHistoryRepo(Number(v))}
      />
    {/if}
    <span class="hist-label">History of</span>
    <BranchPicker
      value={appState.historyRef}
      options={historyBranches}
      placeholder="HEAD (current)"
      onchange={setHistoryRef}
      title="Branch / tag / commit to show history for"
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
