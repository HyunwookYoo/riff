<script lang="ts">
  import { onMount } from "svelte";
  import { reviewState, refreshList, openPr } from "$lib/review/reviewState.svelte";
  import { loginHint } from "$lib/review/prList";
  import { listReviews } from "$lib/review/gh";
  import { loadRecord } from "$lib/review/draftStore";
  import type { PrKey, PrSummary } from "$lib/review/types";

  const requested = $derived(reviewState.prs.filter((p) => p.section === "requested"));
  const reviewed = $derived(reviewState.prs.filter((p) => p.section === "reviewed"));
  const problemHosts = $derived(reviewState.hosts.filter((h) => h.status !== "ready"));

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

  const newCommits = (p: PrSummary) =>
    p.section === "reviewed" && p.myLastReviewSha !== p.headSha;
  const copy = (text: string) => void navigator.clipboard.writeText(text);
</script>

{#snippet section(title: string, prs: PrSummary[])}
  <div class="section-head">{title} <span class="count">{prs.length}</span></div>
  {#each prs as p (p.key)}
    <button
      type="button"
      class="row"
      class:selected={reviewState.selectedKey === p.key}
      onclick={() => void openPr(p.key)}
    >
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
      <div class="host-error">
        <div>
          {h.host}: {h.status}{h.message ? ` — ${h.message}` : ""}
        </div>
        <div class="hint">
          <code>{loginHint(h.host)}</code>
          <button type="button" onclick={() => copy(loginHint(h.host))}>Copy</button>
        </div>
      </div>
    {/each}
    {#if reviewState.error}
      <div class="host-error">{reviewState.error}</div>
    {/if}
    {@render section("Review requested", requested)}
    {@render section("Reviewed", reviewed)}
  </div>
</aside>

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
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    cursor: pointer;
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
  .hint {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .hint code {
    font-family: var(--mono);
    user-select: all;
  }
</style>
