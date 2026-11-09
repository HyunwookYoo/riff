<script lang="ts">
  import { reviewState } from "$lib/review/reviewState.svelte";
  import { viewerLogin } from "$lib/review/github";
  import { aiState, cancelRereviewAi, requestRereviewAi, rereviewButtonState } from "$lib/review/ai/aiState.svelte";
  import { rereviewAvailable } from "$lib/review/ai/rereview";
  import type { PrSummary } from "$lib/review/types";

  let { pr }: { pr: PrSummary } = $props();

  let login = $state<string | null>(null);
  $effect(() => {
    const host = pr.repo.host;
    login = null;
    let live = true;
    viewerLogin(host)
      .then((l) => {
        if (live) login = l;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  const available = $derived(
    login !== null && rereviewAvailable(pr, reviewState.detail?.threads ?? [], login),
  );
  const job = $derived(aiState.rereviewJobs[pr.key]);
  let now = $state(Date.now());
  const running = $derived(job?.kind === "running");
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const btn = $derived(rereviewButtonState(job, now));

  function click() {
    if (btn.busy) cancelRereviewAi(pr.key);
    else if (login) requestRereviewAi(pr, login);
  }
</script>

{#if available || btn.busy}
  <button type="button" class="rereview" class:failed={job?.kind === "failed"} title={btn.title ?? "Check whether the new commits address your open threads"} onclick={click}>
    {btn.text}
  </button>
{/if}

<style>
  .rereview {
    font-size: 0.85em;
  }
  .failed {
    color: var(--error-fg);
  }
</style>
