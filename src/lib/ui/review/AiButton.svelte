<script lang="ts">
  import { aiState, requestAi, cancelAi } from "$lib/review/ai/aiState.svelte";
  import type { PrSummary } from "$lib/review/types";

  let { pr }: { pr: PrSummary } = $props();

  const job = $derived(aiState.jobs[pr.key]);
  const busy = $derived(job?.kind === "queued" || job?.kind === "running");
  const label = $derived(busy ? "Cancel" : aiState.results[pr.key] ? "Re-analyse" : "AI review");

  function click(e: MouseEvent) {
    e.stopPropagation();
    if (busy) cancelAi(pr.key);
    else requestAi(pr);
  }
</script>

<button type="button" class="ai-btn" onclick={click}>{label}</button>

<style>
  .ai-btn {
    font-size: 0.72em;
    padding: 0 6px;
  }
</style>
