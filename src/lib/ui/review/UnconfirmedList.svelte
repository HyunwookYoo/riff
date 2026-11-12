<script lang="ts">
  import type { ShownFinding } from "$lib/review/ai/result";
  import type { PrKey, Side } from "$lib/review/types";
  import InlineFinding from "./InlineFinding.svelte";

  let {
    prKey,
    createdAt,
    findings,
    onevidence,
  }: {
    prKey: PrKey;
    createdAt: string;
    findings: ShownFinding[];
    onevidence: (path: string, line: number | null, side?: Side) => void;
  } = $props();
</script>

{#if findings.length > 0}
  <details class="area">
    <summary>Unconfirmed ({findings.length})</summary>
    {#each findings as f (`${createdAt}:${f.id}`)}
      <div class="entry"><InlineFinding {prKey} {createdAt} finding={f} showPath {onevidence} /></div>
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
  }
</style>
