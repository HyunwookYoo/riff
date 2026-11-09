<script lang="ts">
  import type { AiChapter } from "$lib/review/ai/types";

  let {
    chapter,
    stale,
    onreanalyse,
  }: {
    chapter: AiChapter;
    stale: boolean;
    onreanalyse: () => void;
  } = $props();
</script>

<div class="intent">
  <span class="title">{chapter.title}</span>
  {#if chapter.summary}<span class="summary">{chapter.summary}</span>{/if}
  {#if stale}
    <span class="stale">
      from an older commit ·
      <button type="button" class="link" onclick={onreanalyse}>Re-analyse</button>
    </span>
  {/if}
</div>

<style>
  .intent {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
    font-size: 0.9em;
  }
  .title {
    font-weight: 600;
  }
  .summary {
    color: var(--fg);
  }
  .stale {
    margin-left: auto;
    color: var(--muted);
  }
  .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
  }
</style>
