<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    clearRepoOverride,
    loadBranchesFor,
    setRepoOverride,
  } from "$lib/workspace";
  import BranchPicker from "./BranchPicker.svelte";

  // When Focus targets a non-main repo, the toolbar pickers become an
  // editor for *that* repo's per-repo override (§13.3 #9). Otherwise the
  // pickers drive main's start/target as before.
  const activeRepo = $derived.by(() => {
    const idx = appState.activeRepoIdx;
    if (idx === null) return null;
    const r = appState.repos[idx];
    if (!r || r.kind === "main") return null;
    return { idx, repo: r };
  });

  // Branches for the picker. Main reads from appState.branches directly;
  // non-main repos lazy-load on first focus and cache by idx.
  const branchesForActive = $derived.by(() => {
    if (!activeRepo) return appState.branches;
    return appState.branchesByRepoIdx[activeRepo.idx] ?? [];
  });

  // Trigger lazy-fetch whenever a non-main repo becomes active.
  $effect(() => {
    if (activeRepo) void loadBranchesFor(activeRepo.idx);
  });

  function setStart(v: string) {
    if (activeRepo) {
      setRepoOverride(activeRepo.idx, v, activeRepo.repo.override?.targetBranch ?? "");
    } else {
      appState.startBranch = v;
    }
  }
  function setTarget(v: string) {
    if (activeRepo) {
      setRepoOverride(activeRepo.idx, activeRepo.repo.override?.startBranch ?? "", v);
    } else {
      appState.targetBranch = v;
    }
  }

  function resetActive() {
    if (!activeRepo) return;
    clearRepoOverride(activeRepo.idx);
  }

  // Picker value for the active context. For main, mirror appState directly;
  // for non-main, prefer the saved override (committed value) so the trigger
  // matches what compare actually runs with.
  const startValue = $derived(
    activeRepo
      ? activeRepo.repo.override?.startBranch ?? ""
      : appState.startBranch,
  );
  const targetValue = $derived(
    activeRepo
      ? activeRepo.repo.override?.targetBranch ?? ""
      : appState.targetBranch,
  );

  const startPlaceholder = $derived(
    activeRepo
      ? activeRepo.repo.kind === "submodule"
        ? "follow gitlinks"
        : `default: ${appState.startBranch || "—"}`
      : "start",
  );
  const targetPlaceholder = $derived(
    activeRepo
      ? activeRepo.repo.kind === "submodule"
        ? "follow gitlinks"
        : `default: ${appState.targetBranch || "—"}`
      : "target",
  );
</script>

<BranchPicker
  value={startValue}
  options={branchesForActive}
  placeholder={startPlaceholder}
  onchange={setStart}
  title="Start ref (branch / commit / tag)"
/>
<span class="sep">→</span>
<BranchPicker
  value={targetValue}
  options={branchesForActive}
  placeholder={targetPlaceholder}
  onchange={setTarget}
  title="Target ref"
/>

{#if activeRepo}
  {#if activeRepo.repo.override}
    <button
      type="button"
      class="reset"
      title="Reset to default (clear this repo's override)"
      onclick={resetActive}
    >
      Reset
    </button>
  {/if}
{:else}
  <select bind:value={appState.mode} title="Diff mode">
    <option value="three-dot">3-dot (...)</option>
    <option value="two-dot">2-dot (..)</option>
  </select>
{/if}

<style>
  .sep {
    opacity: 0.6;
  }
  select {
    font-size: 0.9em;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
  }
  .reset {
    font-size: 0.85em;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: var(--muted);
    cursor: pointer;
  }
  .reset:hover {
    background: var(--hover);
    color: inherit;
  }
</style>
