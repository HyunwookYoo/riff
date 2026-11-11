<script lang="ts">
  import { aiState, requestAi, cancelAi } from "$lib/review/ai/aiState.svelte";
  import { hasReview } from "$lib/review/ai/rereview";
  import type { PrSummary } from "$lib/review/types";
  import AiRunMenu from "./AiRunMenu.svelte";

  let { pr }: { pr: PrSummary } = $props();

  const job = $derived(aiState.jobs[pr.key]);
  const busy = $derived(job?.kind === "queued" || job?.kind === "running");
  const result = $derived(aiState.results[pr.key]);
  const label = $derived(busy ? "Cancel" : result && hasReview(result) ? "Re-analyse" : "AI review");

  function click(e: MouseEvent) {
    e.stopPropagation();
    if (busy) cancelAi(pr.key);
    else requestAi(pr);
  }
</script>

<button type="button" class="ai-btn" onclick={click}>{label}</button>
{#if !busy}
  <AiRunMenu what={label} repo={pr.repo} onrun={(c) => requestAi(pr, c)} />
{/if}

<style>
  .ai-btn {
    font-size: 0.72em;
    padding: 0 6px;
  }
</style>
