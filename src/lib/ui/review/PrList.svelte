<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { reviewState, refreshList, openPr } from "$lib/review/reviewState.svelte";
  import { hostProblemText, listEmptyState, loginHint } from "$lib/review/prList";
  import { listReviews } from "$lib/review/gh";
  import { loadRecord } from "$lib/review/draftStore";
  import type { PrKey, PrSummary } from "$lib/review/types";
  import { aiState, loadResultFor } from "$lib/review/ai/aiState.svelte";
  import { aiBadge, aiErrorText } from "$lib/review/ai/badge";
  import AiButton from "./AiButton.svelte";
  import SignInDialog from "./SignInDialog.svelte";

  const requested = $derived(reviewState.prs.filter((p) => p.section === "requested"));
  const reviewed = $derived(reviewState.prs.filter((p) => p.section === "reviewed"));
  const problemHosts = $derived(reviewState.hosts.filter((h) => h.status !== "ready"));
  const emptyState = $derived(
    reviewState.githubRepos === null
      ? null
      : listEmptyState(reviewState.githubRepos, reviewState.hosts, reviewState.prs.length),
  );
  let signInHost = $state<string | null>(null);

  // Draft counts per listed key; absent = no stored record or unreadable (unknown).
  let draftCounts = $state<Record<PrKey, number>>({});
  let countSeq = 0;
  // Re-run when the open PR's draft changes so its badge stays current.
  const openItems = $derived(reviewState.record?.items.length);

  $effect(() => {
    void openItems;
    const listed = reviewState.prs.map((p) => p.key);
    const seq = ++countSeq;
    void (async () => {
      let stored: string[];
      try {
        stored = await listReviews();
      } catch {
        return;
      }
      const have = new Set(stored);
      const next: Record<PrKey, number> = {};
      for (const key of listed) {
        if (!have.has(key)) continue;
        try {
          const n = (await loadRecord(key)).items.length;
          if (n > 0) next[key] = n;
        } catch {
          // unreadable record: unknown, no badge
        }
      }
      if (seq === countSeq) draftCounts = next;
    })();
  });

  let updatedAt = $state<number | null>(null);
  let now = $state(Date.now());
  let wasLoading = false;
  $effect(() => {
    const loading = reviewState.loadingList;
    if (wasLoading && !loading) updatedAt = Date.now();
    wasLoading = loading;
  });
  onMount(() => {
    const id = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(id);
  });
  const updatedText = $derived.by(() => {
    if (reviewState.loadingList) return "updating…";
    if (updatedAt === null) return "";
    const m = Math.max(0, Math.floor((now - updatedAt) / 60_000));
    return m === 0 ? "updated just now" : `updated ${m} min ago`;
  });

  // Results load lazily for every listed PR.
  $effect(() => {
    const keys = reviewState.prs.map((p) => p.key);
    untrack(() => {
      for (const k of keys) void loadResultFor(k);
    });
  });
  // Tick each second only while a job (review or re-review) runs, so "analysing m:ss" advances.
  let aiNow = $state(Date.now());
  const anyRunning = $derived(
    [...Object.values(aiState.jobs), ...Object.values(aiState.rereviewJobs)].some((j) => j.kind === "running"),
  );
  $effect(() => {
    if (!anyRunning) return;
    aiNow = Date.now();
    const id = setInterval(() => (aiNow = Date.now()), 1000);
    return () => clearInterval(id);
  });

  const newCommits = (p: PrSummary) =>
    p.section === "reviewed" && p.myLastReviewSha !== p.headSha;
  const copy = (text: string) => void navigator.clipboard.writeText(text);
</script>

{#snippet section(title: string, prs: PrSummary[])}
  <div class="section-head">{title} <span class="count">{prs.length}</span></div>
  {#each prs as p (p.key)}
    {@const badge = aiBadge(aiState.jobs[p.key], aiState.results[p.key], p.headSha, aiNow)}
    <div class="row" class:selected={reviewState.selectedKey === p.key}>
      <button type="button" class="row-main" onclick={() => void openPr(p.key)}>
        <div class="title">
          <span class="num">#{p.number}</span>
          {p.title}
        </div>
        <div class="meta">
          {p.author} · {p.repo.owner}/{p.repo.name} ·
          <span class="add">+{p.additions}</span>
          <span class="del">−{p.deletions}</span>
        </div>
        {#if draftCounts[p.key] || newCommits(p)}
          <div class="badges">
            {#if draftCounts[p.key]}
              <span class="badge">draft {draftCounts[p.key]}</span>
            {/if}
            {#if newCommits(p)}
              <span class="badge warn">new commits</span>
            {/if}
          </div>
        {/if}
      </button>
      <div class="ai-row">
        <AiButton pr={p} />
        {#if badge.kind !== "none"}
          {@const job = aiState.jobs[p.key]}
          <span
            class="badge"
            class:warn={badge.kind === "stale" || badge.kind === "failed"}
            title={job?.kind === "failed" ? aiErrorText(job.message) : undefined}>{badge.text}</span
          >
        {/if}
      </div>
    </div>
  {/each}
{/snippet}

<aside class="pr-list">
  <div class="toolbar">
    <button type="button" onclick={() => void refreshList()} disabled={reviewState.loadingList}>
      Refresh
    </button>
    <span class="updated">{updatedText}</span>
  </div>
  <div class="scroll">
    {#each problemHosts as h (h.host)}
      {@const t = hostProblemText(h)}
      <div class="host-error">
        <div class="problem-title">{t.title}</div>
        {#if t.detail}
          <div class="detail">{t.detail}</div>
        {/if}
        {#if t.canSignIn}
          <button type="button" class="sign-in" onclick={() => (signInHost = h.host)}>Sign in</button>
          <div class="hint">
            or run: <code>{loginHint(h.host)}</code>
            <button type="button" onclick={() => copy(loginHint(h.host))}>Copy</button>
          </div>
        {/if}
      </div>
    {/each}
    {#if reviewState.error}
      <div class="host-error">{reviewState.error}</div>
    {/if}
    {#if emptyState === "no-github-repos"}
      <div class="empty">None of the open repositories has a GitHub remote.</div>
    {:else if emptyState === "no-prs"}
      <div class="empty">No review requests right now.</div>
    {/if}
    {@render section("Review requested", requested)}
    {@render section("Reviewed", reviewed)}
  </div>
</aside>
{#if signInHost}
  <SignInDialog host={signInHost} onclose={() => (signInHost = null)} />
{/if}

<style>
  .pr-list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--sidebar-bg, var(--bar-bg));
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  .updated {
    color: var(--muted);
    font-size: 0.8em;
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
  }
  .section-head {
    padding: 6px 8px;
    font-weight: 600;
    font-size: 0.85em;
    border-bottom: 1px solid var(--border);
  }
  .count {
    color: var(--muted);
    font-weight: 400;
  }
  .row {
    border-bottom: 1px solid var(--border);
  }
  .row-main {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 8px 2px;
    border: none;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
  }
  .ai-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px 6px;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.selected {
    background: var(--accent-soft);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .num {
    color: var(--muted);
    font-family: var(--mono);
  }
  .meta {
    color: var(--muted);
    font-size: 0.8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add {
    color: var(--ok-fg, #2da44e);
  }
  .del {
    color: var(--danger, #cf222e);
  }
  .badges {
    display: flex;
    gap: 4px;
    margin-top: 3px;
  }
  .badge {
    font-size: 0.72em;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .badge.warn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .host-error {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    font-size: 0.85em;
  }
  .problem-title {
    font-weight: 600;
  }
  .detail {
    margin-top: 2px;
    color: var(--muted);
    word-break: break-word;
  }
  .sign-in {
    margin-top: 6px;
  }
  .hint {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .empty {
    padding: 12px 8px;
    color: var(--muted);
    font-size: 0.85em;
  }
  .hint code {
    font-family: var(--mono);
    user-select: all;
  }
</style>
