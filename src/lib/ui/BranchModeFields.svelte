<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { clearRepoOverride, setRepoOverride } from "$lib/workspace";

  // When Focus targets a non-main repo, the toolbar inputs become an
  // editor for *that* repo's per-repo override (§13.3 #9). Otherwise the
  // inputs drive main's start/target as before.
  const activeRepo = $derived.by(() => {
    const idx = appState.activeRepoIdx;
    if (idx === null) return null;
    const r = appState.repos[idx];
    if (!r || r.kind === "main") return null;
    return { idx, repo: r };
  });

  // Draft inputs used only while editing a non-main repo. The current
  // override (or "") is loaded into them whenever the active target
  // changes; commit-on-blur / Enter pushes them through setRepoOverride.
  let draftStart = $state("");
  let draftTarget = $state("");
  let activeKey = $state<string | null>(null);

  $effect(() => {
    const next = activeRepo;
    const key = next ? next.repo.path : null;
    if (key !== activeKey) {
      activeKey = key;
      draftStart = next?.repo.override?.startBranch ?? "";
      draftTarget = next?.repo.override?.targetBranch ?? "";
    }
  });

  // Placeholder text reflects the fall-through behavior so an empty input
  // isn't mysterious — it shows what would happen if the user committed
  // empty refs (which is rejected; see commitOverride).
  function startPlaceholder(): string {
    if (!activeRepo) return "start (branch / commit / tag)";
    if (activeRepo.repo.kind === "submodule") return "start (follow gitlinks)";
    return `start (default: ${appState.startBranch || "—"})`;
  }
  function targetPlaceholder(): string {
    if (!activeRepo) return "target";
    if (activeRepo.repo.kind === "submodule") return "target (follow gitlinks)";
    return `target (default: ${appState.targetBranch || "—"})`;
  }

  function commitOverride() {
    if (!activeRepo) return;
    const s = draftStart.trim();
    const t = draftTarget.trim();
    if (!s || !t) return;
    setRepoOverride(activeRepo.idx, s, t);
  }

  function resetActive() {
    if (!activeRepo) return;
    draftStart = "";
    draftTarget = "";
    clearRepoOverride(activeRepo.idx);
  }
</script>

{#if activeRepo}
  <input
    type="text"
    class="ref"
    placeholder={startPlaceholder()}
    bind:value={draftStart}
    onkeydown={(e) => e.key === "Enter" && commitOverride()}
    onblur={commitOverride}
  />
  <span class="sep">→</span>
  <input
    type="text"
    class="ref"
    placeholder={targetPlaceholder()}
    bind:value={draftTarget}
    onkeydown={(e) => e.key === "Enter" && commitOverride()}
    onblur={commitOverride}
  />
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
{/if}

<style>
  .ref {
    width: 180px;
    font-size: 0.9em;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
  }
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
