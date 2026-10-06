<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    clearRepoOverride,
    loadBranchesFor,
    setRepoOverride,
  } from "$lib/workspace";
  import { possessive, scopeLine } from "$lib/rangeText";
  import BranchPicker from "./BranchPicker.svelte";

  // The repo the view is narrowed to: Focus in Unified, the active tab in Tabs.
  // The super repo needs no bar in either — the toolbar already is its pair.
  const idx = $derived.by(() => {
    const i = appState.activeRepoIdx;
    if (i === null || i === 0 || appState.repos.length < 2) return null;
    return i;
  });
  const repo = $derived(idx === null ? null : (appState.repos[idx] ?? null));
  const range = $derived(idx === null ? undefined : appState.repoRanges[idx]);
  const superName = $derived(appState.repos[0]?.displayName ?? "");
  const pair = $derived({
    base: appState.startBranch,
    compare: appState.targetBranch,
  });
  const line = $derived(
    repo && range ? scopeLine(range, repo.displayName, superName, pair) : null,
  );
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
    <span class="kind" data-kind={repo.kind}>{repo.kind}</span>
    {#if repo.override}
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
      <span class="why">{possessive(repo.displayName)} own branches</span>
      <button type="button" onclick={followDefault}>
        {repo.kind === "submodule"
          ? `Back to ${possessive(superName)} commits`
          : "Back to same names"}
      </button>
    {:else}
      {#if line && line.kind === "sides"}
        <span class="side">base <code>{line.base}</code></span>
        <span class="sep">←</span>
        <span class="side">compare <code>{line.compare}</code></span>
        <span class="why">{line.why}</span>
      {:else}
        <span class="why">{line && line.kind === "note" ? line.text : "…"}</span>
      {/if}
      <button type="button" onclick={compareOwnBranches}>
        Pick its own branches…
      </button>
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
  .side {
    color: var(--muted);
  }
  .side code {
    font-family: var(--mono);
    color: var(--fg);
  }
  .why {
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
</style>
