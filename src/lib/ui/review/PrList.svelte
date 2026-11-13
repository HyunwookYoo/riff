<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { reviewState, refreshList, openPr } from "$lib/review/reviewState.svelte";
  import { hostProblemText, listEmptyState, loginHint } from "$lib/review/prList";
  import { listReviews } from "$lib/review/gh";
  import { loadRecord } from "$lib/review/draftStore";
  import type { PrKey, PrSummary } from "$lib/review/types";
  import { aiState, loadResultsFor } from "$lib/review/ai/aiState.svelte";
  import { aiBadge, aiBadgeTitle } from "$lib/review/ai/badge";
  import { applyFilter, DEFAULT_FILTER, emptyMessage, filterActive, highlight, isNumberQuery, ME, type PrFilter } from "$lib/review/prFilter";
  import { appState } from "$lib/store.svelte";
  import { setPrListFilter } from "$lib/git";
  import AiButton from "./AiButton.svelte";
  import PrFilterBar from "./PrFilterBar.svelte";
  import SignInDialog from "./SignInDialog.svelte";

  let { collapsed = false, ontoggle }: {
    /** Only the toolbar shows; the list is folded away. */
    collapsed?: boolean;
    ontoggle?: () => void;
  } = $props();

  const shown = $derived(applyFilter(reviewState.prs, appState.prListFilter, reviewState.listQuery));
  const active = $derived(filterActive(appState.prListFilter, reviewState.listQuery));
  const problemHosts = $derived(reviewState.hosts.filter((h) => h.status !== "ready"));
  const failedRepos = $derived(
    reviewState.hosts.flatMap((h) => (h.failedRepos ?? []).map((f) => ({ ...f, id: `${h.host}/${f.repo}` }))),
  );
  /** Row ids for aria-describedby: unique within this list. */
  const uid = $props.id();
  const emptyState = $derived(
    reviewState.githubRepos === null
      ? null
      : listEmptyState(reviewState.githubRepos, reviewState.hosts, reviewState.prs.length),
  );
  const empty = $derived(emptyMessage(emptyState, appState.prListFilter, reviewState.listQuery, shown));
  // The bar shows once PRs are listed, or none are open (so a remembered For me stays visible).
  const showBar = $derived(reviewState.prs.length > 0 || emptyState === "no-prs");
  const numberQuery = $derived(isNumberQuery(reviewState.listQuery));
  let signInHost = $state<string | null>(null);

  /** Show / author / repo apply at once and are saved; a failed save only loses them on restart. */
  function setFilter(patch: Partial<PrFilter>) {
    const next = { ...appState.prListFilter, ...patch };
    appState.prListFilter = next;
    setPrListFilter(next).catch((e) => console.warn("PR list filter not saved:", e));
  }
  function clearFilters() {
    reviewState.listQuery = "";
    if (filterActive(appState.prListFilter, "")) setFilter({ ...DEFAULT_FILTER });
  }

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

  // Results load lazily for the PRs shown (the list can be hundreds long) and the
  // open PR, which the filter may hide.
  $effect(() => {
    const keys = shown.list.map((p) => p.key);
    const selected = reviewState.selectedKey;
    if (selected !== null && !keys.includes(selected)) keys.push(selected);
    untrack(() => void loadResultsFor(keys));
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
    p.mine === "reviewed" && p.myLastReviewSha !== p.headSha;
  const copy = (text: string) => void navigator.clipboard.writeText(text);
</script>

{#snippet rows(prs: PrSummary[], pills: boolean)}
  {#each prs as p (p.key)}
    {@const badge = aiBadge(aiState.jobs[p.key], aiState.results[p.key], p.headSha, aiNow)}
    {@const pill = pills && p.mine !== null}
    {@const hasBadges = !!(pill || draftCounts[p.key] || newCommits(p))}
    {@const descId = `${uid}-${p.key}`}
    <div class="row" class:selected={reviewState.selectedKey === p.key}>
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="row-main" onclick={() => void openPr(p.key)} role="presentation">
        <!-- No handler of its own: its click (mouse, Enter or Space) bubbles to the row. -->
        <button
          type="button"
          class="title"
          aria-describedby={hasBadges ? `${descId}-meta ${descId}-badges` : `${descId}-meta`}
        >
          {#if numberQuery}<mark class="num">#{p.number}</mark>{:else}<span class="num">#{p.number}</span>{/if}
          {#each highlight(p.title, reviewState.listQuery) as seg}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}
        </button>
        <div class="meta" id="{descId}-meta">
          <button
            type="button"
            class="who"
            title="Show {p.author}'s PRs"
            onclick={(e) => {
              e.stopPropagation();
              setFilter({ author: p.author === p.viewer ? ME : p.author });
            }}>{p.author}</button
          >
          · {p.repo.owner}/{p.repo.name} ·
          <span class="add">+{p.additions}</span>
          <span class="del">−{p.deletions}</span>
        </div>
        {#if hasBadges}
          <div class="badges" id="{descId}-badges">
            {#if pill}
              <span class="badge pill" class:done={p.mine === "reviewed"}
                >{p.mine === "requested" ? "review requested" : "reviewed"}</span
              >
            {/if}
            {#if draftCounts[p.key]}
              <span class="badge">draft {draftCounts[p.key]}</span>
            {/if}
            {#if newCommits(p)}
              <span class="badge warn">new commits</span>
            {/if}
          </div>
        {/if}
      </div>
      <div class="ai-row">
        <AiButton pr={p} />
        {#if badge.kind !== "none"}
          <span
            class="badge"
            class:warn={badge.kind === "stale" || badge.kind === "failed"}
            title={aiBadgeTitle(aiState.jobs[p.key], aiState.results[p.key])}>{badge.text}</span
          >
        {/if}
      </div>
    </div>
  {/each}
{/snippet}

{#snippet section(title: string, prs: PrSummary[])}
  {#if prs.length}
    <div class="section-head">{title} <span class="count">{prs.length}</span></div>
    {@render rows(prs, false)}
  {/if}
{/snippet}

<aside class="pr-list">
  <div class="toolbar">
    <button type="button" class="fold" onclick={() => ontoggle?.()} aria-expanded={!collapsed} title={collapsed ? "Show pull requests" : "Hide pull requests"}>
      {collapsed ? "▸" : "▾"} Pull requests <span class="fold-count">{reviewState.prs.length}</span>
    </button>
    <span class="spacer"></span>
    <button type="button" onclick={() => void refreshList()} disabled={reviewState.loadingList}>
      Refresh
    </button>
    <span class="updated">{updatedText}</span>
  </div>
  {#if !collapsed && showBar}
    <PrFilterBar
      prs={reviewState.prs}
      filter={appState.prListFilter}
      result={shown}
      {active}
      bind:query={reviewState.listQuery}
      onfilter={setFilter}
      onclear={clearFilters}
    />
  {/if}
  <div class="scroll" hidden={collapsed}>
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
    {#each failedRepos as f (f.id)}
      <div class="host-error repo-warn" title={f.message}>Couldn't load open PRs of {f.repo}</div>
    {/each}
    {#if reviewState.error}
      <div class="host-error">{reviewState.error}</div>
    {/if}
    {#if empty}
      <div class="empty">
        {empty.text}
        {#if empty.clear}
          <div><button type="button" class="clear-filters" onclick={clearFilters}>Clear filters</button></div>
        {/if}
      </div>
    {/if}
    {#if shown.sections}
      {@render section("Review requested", shown.sections.requested)}
      {@render section("Reviewed by me", shown.sections.reviewed)}
    {:else}
      {@render rows(shown.list, true)}
    {/if}
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
  .fold {
    border: none;
    background: transparent;
    padding: 0;
    font-weight: 600;
    cursor: pointer;
  }
  .fold-count {
    color: var(--muted);
    font-weight: 400;
  }
  .spacer {
    flex: 1;
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
    padding: 6px 8px 2px;
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
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  mark {
    background: var(--info-bg);
    color: inherit;
    border-radius: 2px;
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
  .who {
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
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
  .badge.pill {
    background: transparent;
    border: 1px solid var(--accent);
  }
  .badge.pill.done {
    border-color: var(--diff-add-border);
    color: var(--diff-add-border);
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
  .repo-warn {
    color: var(--muted);
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
  .clear-filters {
    margin-top: 8px;
  }
  .hint code {
    font-family: var(--mono);
    user-select: all;
  }
</style>
