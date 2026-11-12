<script lang="ts">
  import { reviewState } from "$lib/review/reviewState.svelte";
  import type { RefutedFinding } from "$lib/review/ai/types";
  import type { Side } from "$lib/review/types";

  let {
    refuted,
    onevidence,
  }: {
    refuted: RefutedFinding[];
    onevidence: (path: string, line: number | null, side?: Side) => void;
  } = $props();

  const inPr = (path: string) => reviewState.files.some((x) => x.path === path);
</script>

{#if refuted.length > 0}
  <details class="area">
    <summary>Refuted by verification ({refuted.length})</summary>
    {#each refuted as r, i (i)}
      <div class="entry">
        {#if inPr(r.path)}
          <button type="button" class="link" title={r.path} onclick={() => onevidence(r.path, r.line, r.side)}>{r.path}:{r.line}</button>
        {:else}
          <span class="loc" title={r.path}>{r.path}:{r.line}</span>
        {/if}
        · {r.severity} · {r.summary}
        <span class="muted">— {r.reason}</span>
      </div>
    {/each}
  </details>
{/if}

<style>
  .area {
    border-top: 1px solid var(--border);
    padding: 4px 8px;
    font-size: 0.85em;
  }
  .area summary {
    cursor: pointer;
    font-weight: 600;
  }
  .entry {
    margin-top: 6px;
    word-break: break-word;
  }
  .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--mono);
  }
  .loc {
    font-family: var(--mono);
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
  }
</style>
