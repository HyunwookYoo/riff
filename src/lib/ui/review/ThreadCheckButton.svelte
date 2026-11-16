<script lang="ts">
  import { reviewState } from "$lib/review/reviewState.svelte";
  import { viewerLogin } from "$lib/review/github";
  import { aiState, cancelThreadCheckAi, requestThreadCheckAi, threadCheckButtonState } from "$lib/review/ai/aiState.svelte";
  import { MAX_THREADS, threadCheckAvailable } from "$lib/review/ai/threadCheck";
  import type { PrSummary } from "$lib/review/types";
  import AiRunMenu from "./AiRunMenu.svelte";

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
    login !== null && threadCheckAvailable(pr, reviewState.detail?.threads ?? [], login),
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
  const btn = $derived(threadCheckButtonState(job, now));
  // Threads the last run at this head left out for the cap.
  const run = $derived(aiState.results[pr.key]?.threadCheckRun);
  const leftOut = $derived(run?.head === pr.headSha ? run.leftOut : 0);

  function click() {
    if (btn.busy) cancelThreadCheckAi(pr.key);
    else if (login) requestThreadCheckAi(pr, login);
  }
</script>

{#if available || btn.busy}
  <div>
    <div class="run">
      <button type="button" class="btn" class:failed={job?.kind === "failed"} title={btn.title ?? "Check the open points of threads waiting on you against the code"} onclick={click}>
        {btn.text}
      </button>
      {#if !btn.busy && login}
        {@const me = login}
        <AiRunMenu what="Check threads" onrun={(c) => requestThreadCheckAi(pr, me, c)} />
      {/if}
    </div>
    {#if leftOut > 0}
      <p class="muted">{leftOut} thread{leftOut === 1 ? "" : "s"} not checked (limit {MAX_THREADS})</p>
    {/if}
  </div>
{/if}

<style>
  .run {
    display: flex;
  }
  .btn,
  .muted {
    font-size: 0.85em;
  }
  .failed {
    color: var(--error-fg);
  }
  .muted {
    margin: 2px 0 0;
    color: var(--muted);
  }
</style>
