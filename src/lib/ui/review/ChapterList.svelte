<script lang="ts">
  import type { Snippet } from "svelte";
  import type { AiChapter } from "$lib/review/ai/types";

  let {
    chapters,
    findingCounts,
    row,
  }: {
    chapters: AiChapter[];
    /** Shown findings (inline and off-diff) per path. */
    findingCounts: Map<string, number>;
    row: Snippet<[string]>;
  } = $props();

  const count = (c: AiChapter) => c.paths.reduce((n, p) => n + (findingCounts.get(p) ?? 0), 0);
</script>

{#each chapters as c, i (i)}
  <div class="chapter" title={c.summary || undefined}>
    <span class="title">{c.title}</span>
    <span class="muted">{c.paths.length}</span>
    {#if count(c)}<span class="badge">{count(c)} finding{count(c) === 1 ? "" : "s"}</span>{/if}
  </div>
  {#each c.paths as p (p)}
    {@render row(p)}
  {/each}
{/each}

<style>
  .chapter {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    font-weight: 600;
    font-size: 0.85em;
    border-bottom: 1px solid var(--border);
  }
  .chapter:not(:first-child) {
    border-top: 1px solid var(--border);
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--muted);
    font-weight: 400;
  }
  .badge {
    flex: none;
    margin-left: auto;
    font-weight: 400;
    padding: 0 6px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
</style>
