<script lang="ts">
  import { authorOptions, ME, repoOptions, summaryText, type FilterResult, type PrFilter } from "$lib/review/prFilter";
  import type { PrSummary } from "$lib/review/types";

  let { prs, filter, result, active, query = $bindable(), onfilter, onclear }: {
    /** Every listed PR: the Author and Repo options count these. */
    prs: PrSummary[];
    filter: PrFilter;
    result: FilterResult;
    /** Whether any filter or the search hides PRs. */
    active: boolean;
    query: string;
    onfilter: (patch: Partial<PrFilter>) => void;
    onclear: () => void;
  } = $props();

  const authors = $derived(authorOptions(prs, filter.author));
  const repos = $derived(repoOptions(prs, filter.repo));
  let input = $state<HTMLInputElement>();

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && query) {
      query = "";
      e.preventDefault();
    }
  }
</script>

<div class="filters">
  <div class="search">
    <span class="icon" aria-hidden="true">⌕</span>
    <input
      bind:this={input}
      type="text"
      placeholder="Search title or #number"
      aria-label="Search pull requests"
      autocomplete="off"
      spellcheck="false"
      bind:value={query}
      {onkeydown}
    />
    {#if query}
      <button
        type="button"
        class="clear"
        title="Clear"
        aria-label="Clear search"
        onclick={() => {
          query = "";
          input?.focus();
        }}>✕</button
      >
    {/if}
  </div>
  <div class="frow">
    <div class="seg" role="group" aria-label="Show">
      <button
        type="button"
        class:on={filter.show === "all"}
        aria-pressed={filter.show === "all"}
        onclick={() => onfilter({ show: "all" })}>All<span class="n">{result.counts.all}</span></button
      >
      <button
        type="button"
        class:on={filter.show === "mine"}
        aria-pressed={filter.show === "mine"}
        onclick={() => onfilter({ show: "mine" })}>For me<span class="n">{result.counts.mine}</span></button
      >
    </div>
    <select
      title="Author"
      aria-label="Author"
      class:active={filter.author !== null}
      onchange={(e) => onfilter({ author: e.currentTarget.value || null })}
    >
      <option value="" selected={filter.author === null}>Author: Anyone</option>
      <option value={ME} selected={filter.author === ME}>Author: Me ({authors.meCount})</option>
      {#each authors.authors as a (a.login)}
        <option value={a.login} selected={filter.author === a.login}>{a.login} ({a.count})</option>
      {/each}
    </select>
    {#if repos.showRepoFilter || filter.repo !== null}
      <select
        title="Repository"
        aria-label="Repository"
        class:active={filter.repo !== null}
        onchange={(e) => onfilter({ repo: e.currentTarget.value || null })}
      >
        <option value="" selected={filter.repo === null}>All repos</option>
        {#each repos.repos as r (r.key)}
          <option value={r.key} selected={filter.repo === r.key}>{r.label} ({r.count})</option>
        {/each}
      </select>
    {/if}
  </div>
  <div class="summary">
    <span>{summaryText(result.list.length, result.total, active)}</span>
    {#if active}
      <button type="button" class="link" onclick={onclear}>Clear filters</button>
    {/if}
  </div>
</div>

<style>
  .filters {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  .search {
    position: relative;
  }
  .search input {
    width: 100%;
    padding: 4px 24px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.85em;
  }
  .search .icon {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--muted);
    font-size: 0.85em;
    pointer-events: none;
  }
  .search .clear {
    position: absolute;
    right: 2px;
    top: 50%;
    transform: translateY(-50%);
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    line-height: 1;
    padding: 0 4px;
  }
  .frow {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .seg button {
    border: none;
    border-radius: 0;
    background: var(--input-bg);
    padding: 2px 8px;
    font-size: 0.85em;
    cursor: pointer;
  }
  .seg button + button {
    border-left: 1px solid var(--border);
  }
  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .n {
    margin-left: 4px;
    color: var(--muted);
    font-weight: 400;
  }
  .seg button.on .n {
    color: var(--accent);
  }
  select {
    flex: 1 1 90px;
    min-width: 0;
    padding: 2px 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.85em;
  }
  select.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .summary {
    display: flex;
    justify-content: space-between;
    color: var(--muted);
    font-size: 0.8em;
  }
  .link {
    border: none;
    background: transparent;
    padding: 0;
    color: var(--accent);
    font-size: 1em;
    cursor: pointer;
  }
</style>
