<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { exitFocus } from "$lib/focus";
  import {
    clearRepoOverride,
    loadBranchesFor,
    setRepoOverride,
  } from "$lib/workspace";
  import { scopeText } from "$lib/rangeText";
  import BranchPicker from "./BranchPicker.svelte";

  // The repo the view is narrowed to: Focus in Unified, the active tab in Tabs.
  // Main's tab needs no bar — the toolbar already is main's pair.
  const isTabs = $derived(appState.workspaceLayout === "tabs");
  const idx = $derived.by(() => {
    const i = appState.activeRepoIdx;
    if (i === null || appState.repos.length < 2) return null;
    if (isTabs && i === 0) return null;
    return i;
  });
  const repo = $derived(idx === null ? null : (appState.repos[idx] ?? null));
  const range = $derived(idx === null ? undefined : appState.repoRanges[idx]);
  const superName = $derived(appState.repos[0]?.displayName ?? "");
  const pair = $derived({
    base: appState.startBranch,
    compare: appState.targetBranch,
  });
  const branches = $derived(
    idx === null ? [] : (appState.branchesByRepoIdx[idx] ?? []),
  );

  $effect(() => {
    if (idx !== null && idx !== 0) void loadBranchesFor(idx);
  });

  /// Compare this repo on its own pair, seeded with what is on screen so
  /// nothing changes until a ref is picked.
  function compareOwnBranches() {
    if (idx === null) return;
    let base = "";
    let compare = "";
    if (range?.ok) {
      base = range.base;
      compare = range.compare;
    } else if (range?.reason === "unchanged") {
      base = range.pin ?? "";
      compare = range.pin ?? "";
    } else if (range?.reason === "added") {
      compare = range.pin ?? "";
    } else if (range?.reason === "removed") {
      base = range.pin ?? "";
    }
    setRepoOverride(idx, base, compare);
  }

  function setOwn(side: "base" | "compare", v: string) {
    if (idx === null || !repo?.override) return;
    const o = repo.override;
    setRepoOverride(
      idx,
      side === "base" ? v : o.startBranch,
      side === "compare" ? v : o.targetBranch,
    );
  }

  function followDefault() {
    if (idx !== null) clearRepoOverride(idx);
  }
</script>

{#if repo}
  <div class="scope" role="group" aria-label="Scope">
    <span class="name">{repo.displayName}</span>
    <span class="kind" data-kind={repo.kind}>
      {repo.kind === "main" ? "super" : repo.kind}
    </span>
    {#if repo.kind !== "main"}
      {#if repo.override}
        <span class="what">own branches:</span>
        <BranchPicker
          label="base"
          value={repo.override.startBranch}
          options={branches}
          placeholder="pick a ref"
          onchange={(v) => setOwn("base", v)}
          title="This repo's own base"
        />
        <span class="sep">←</span>
        <BranchPicker
          label="compare"
          value={repo.override.targetBranch}
          options={branches}
          placeholder="pick a ref"
          onchange={(v) => setOwn("compare", v)}
          title="This repo's own compare"
        />
        <button type="button" onclick={followDefault}>
          {repo.kind === "submodule" ? `Follow ${superName}` : "Use same names"}
        </button>
      {:else}
        <span class="what">{range ? scopeText(range, superName, pair) : "…"}</span>
        <button type="button" onclick={compareOwnBranches}>
          Compare own branches…
        </button>
      {/if}
    {/if}
    {#if !isTabs}
      <button type="button" class="exit" onclick={exitFocus}>× All repos</button>
    {/if}
  </div>
{/if}

<style>
  .scope {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 4px 10px;
    background: var(--accent-soft);
    border-bottom: 1px solid var(--accent);
    font-size: 0.85em;
  }
  .name {
    font-weight: 600;
    font-family: var(--mono);
  }
  .kind {
    font-size: 0.72em;
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .kind[data-kind="submodule"] {
    color: var(--accent);
    border-color: var(--accent);
  }
  .what {
    font-family: var(--mono);
    color: var(--muted);
  }
  .sep {
    opacity: 0.6;
  }
  button {
    font-size: 0.95em;
    padding: 3px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .exit {
    margin-left: auto;
  }
</style>
