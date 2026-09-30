<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    PAGE_SIZE,
    groupCounts,
    isRepoVisible,
    loadBranchContainment,
    loadMoreGroup,
    rowMark,
    selectBranchCommit,
    setShowMerged,
    showAllChanges,
    squashLanded,
    summarize,
    type VisibleGroup,
  } from "$lib/branchContainment";
  import { rangeLabel, rangeTooltip, sideNames } from "$lib/rangeText";
  import {
    groupCountsText,
    noGroupSummaryText,
    shortDate,
    statusText,
    summaryText,
    type RowMark,
  } from "$lib/commitTableText";
  import type { BcGroup, Commit, RepoEntry } from "$lib/types";

  // Rebuild when the compared refs or the repo change — including when the
  // repo moves under us (refsRefresh: fetch, checkout, rebase, push, another
  // tool). Focus and tabs only filter what is shown, so they reload nothing.
  $effect(() => {
    void appState.startBranch;
    void appState.targetBranch;
    void appState.repoPath;
    void appState.refsRefresh;
    void appState.repos;
    if (appState.appMode === "compare") void loadBranchContainment();
  });

  const pair = $derived({
    base: appState.startBranch,
    compare: appState.targetBranch,
  });
  const superName = $derived(appState.repos[0]?.displayName ?? "");
  const multi = $derived(appState.repos.length > 1);

  // Every repo on screen, in workspace order: those with a group, and those
  // whose range did not resolve (a dimmed header that says why).
  const rows = $derived.by(() => {
    const out: { idx: number; repo: RepoEntry; group: BcGroup | null }[] = [];
    appState.repos.forEach((repo, idx) => {
      if (!isRepoVisible(idx) || !appState.repoRanges[idx]) return;
      out.push({ idx, repo, group: appState.bcGroups[idx] ?? null });
    });
    return out;
  });

  const visible = $derived<VisibleGroup[]>(
    rows.flatMap((r) => {
      const range = appState.repoRanges[r.idx];
      return r.group && range?.ok
        ? [{ idx: r.idx, group: r.group, names: sideNames(range, pair) }]
        : [];
    }),
  );
  // With no group on screen (a tab or Focus on a repo without a range), the
  // visible repo's own reason, unless refs are still to be picked.
  const summary = $derived(
    visible.length > 0
      ? summaryText(summarize(visible, pair))
      : noGroupSummaryText(
          pair,
          rows.length > 0 ? appState.repoRanges[rows[0].idx] : undefined,
          superName,
        ),
  );

  // O(1) marks per row.
  const sets = $derived.by(() => {
    const m = new Map<number, { notIn: Set<string>; equiv: Set<string> }>();
    for (const [k, g] of Object.entries(appState.bcGroups)) {
      m.set(Number(k), {
        notIn: new Set(g.marks?.not_in_target ?? []),
        equiv: new Set(g.marks?.equivalent ?? []),
      });
    }
    return m;
  });
  function markOf(idx: number, sha: string): RowMark {
    const s = sets.get(idx);
    const g = appState.bcGroups[idx];
    return s ? rowMark(sha, s.notIn, s.equiv, !!g && !!squashLanded(g)) : "in";
  }
  const glyph: Record<RowMark, string> = { out: "●", patch: "◐", squash: "◐", in: "✓" };

  let collapsed = $state(new Set<number>());
  function toggleGroup(idx: number) {
    const next = new Set(collapsed);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    collapsed = next;
  }

  function isPicked(idx: number, sha: string): boolean {
    const sel = appState.bcSelected;
    return !!sel && sel.repoIdx === idx && sel.commit.sha === sha;
  }
  function clickRow(idx: number, c: Commit) {
    if (isPicked(idx, c.sha)) showAllChanges();
    else selectBranchCommit(idx, c);
  }

  // How many unmerged rows are still unloaded (default list only).
  function leftCount(g: BcGroup): number | null {
    if (appState.bcShowMerged || !g.marks) return null;
    return Math.max(0, g.marks.ahead - g.commits.length);
  }
</script>

<div class="ct">
  <div class="ct-summary">
    <span class="text" title={summary}>{summary}</span>
    <label class="toggle" title="Also list the commits already in base">
      <input
        type="checkbox"
        checked={appState.bcShowMerged}
        onchange={(e) => void setShowMerged(e.currentTarget.checked)}
      />
      Show merged commits
    </label>
    <button
      type="button"
      class="collapse"
      title={appState.commitTableCollapsed ? "Show the commits" : "Hide the commits"}
      onclick={() => (appState.commitTableCollapsed = !appState.commitTableCollapsed)}
    >
      {appState.commitTableCollapsed ? "▾ show commits" : "▴"}
    </button>
  </div>

  {#if !appState.commitTableCollapsed}
    <div class="ct-head" aria-hidden="true">
      <span></span><span>SHA</span><span>Summary</span><span>Author</span><span>Date</span><span>Status</span>
    </div>
    <div class="ct-body">
      {#each rows as r (r.idx)}
        {@const range = appState.repoRanges[r.idx]}
        {@const g = r.group}
        {#if multi}
          <div class="ct-group" class:dim={!g}>
            <button
              type="button"
              class="g-toggle"
              disabled={!g}
              onclick={() => toggleGroup(r.idx)}
            >
              <span class="caret">{!g || collapsed.has(r.idx) ? "▸" : "▾"}</span>
              <span class="g-name">{r.repo.displayName}</span>
            </button>
            <span class="kind" data-kind={r.repo.kind}>
              {r.repo.kind === "main" ? "super" : r.repo.kind}
            </span>
            <span class="g-range" title={rangeTooltip(range, pair)}>
              {rangeLabel(range, superName, pair)}
            </span>
            {#if g && range.ok}
              <span class="g-counts">
                {#if g.status === "loading"}
                  loading commits…
                {:else if g.status === "error"}
                  couldn't read commits
                {:else}
                  {groupCountsText(groupCounts(g), sideNames(range, pair), {
                    mergedBy: g.mergedBy,
                    landed: squashLanded(g),
                    checking: g.squash === "checking",
                  })}
                {/if}
              </span>
            {/if}
          </div>
        {/if}
        {#if g && range.ok && !collapsed.has(r.idx)}
          {@const names = sideNames(range, pair)}
          {#if g.status === "error"}
            <div class="ct-note error">Couldn't read commits: {g.error}</div>
          {:else}
            {#if g.status === "loading" && g.commits.length === 0}
              <!-- A big repo can take a while on a cold cache; say so rather
                   than look like it has no commits. -->
              <div class="ct-note">Loading commits…</div>
            {/if}
            {#if appState.bcShowMerged && g.mergedBy}
              <div class="ct-sub">brought in by {g.mergedBy.short_sha}</div>
            {/if}
            {#each g.commits as c (c.sha)}
              {@const mark = markOf(r.idx, c.sha)}
              <button
                type="button"
                class="ct-row"
                class:sel={isPicked(r.idx, c.sha)}
                class:dim={mark === "in"}
                onclick={() => clickRow(r.idx, c)}
                title={c.summary}
              >
                <span class="mark {mark}">{glyph[mark]}</span>
                <span class="sha">{c.short_sha}</span>
                <span class="sum">
                  {#if c.parents.length > 1}<span class="mtag">merge</span>{/if}{c.summary}
                </span>
                <span class="author">{c.author}</span>
                <span class="date">{shortDate(c.time)}</span>
                <span class="status {mark}">{statusText(mark, names, squashLanded(g))}</span>
              </button>
            {/each}
            {#if g.hasMore}
              {@const left = leftCount(g)}
              <button
                type="button"
                class="ct-more"
                disabled={g.loadingMore}
                onclick={() => void loadMoreGroup(r.idx)}
              >
                {g.loadingMore
                  ? "Loading…"
                  : left !== null
                    ? `Load ${PAGE_SIZE} more (${left} left)`
                    : `Load ${PAGE_SIZE} more`}
              </button>
            {/if}
          {/if}
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .ct {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
    font-size: 0.84em;
  }
  .ct-summary {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .ct-summary .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }
  .collapse {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--muted);
    cursor: pointer;
    padding: 1px 8px;
    font: inherit;
  }
  .ct-head,
  .ct-row {
    display: grid;
    grid-template-columns: 16px 64px minmax(0, 1fr) 110px 64px minmax(120px, 190px);
    gap: 8px;
    align-items: center;
    padding: 3px 10px;
  }
  .ct-head {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 0.85em;
    border-bottom: 1px solid var(--border);
  }
  .ct-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .ct-group {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 10px;
    background: var(--sidebar-bg);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
  }
  .ct-group.dim {
    opacity: 0.6;
  }
  .g-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 0;
  }
  .g-toggle:disabled {
    cursor: default;
  }
  .kind {
    font-size: 0.72em;
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .kind[data-kind="submodule"] {
    color: var(--accent);
    border-color: var(--accent);
  }
  .g-range {
    font-family: var(--mono);
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .g-counts {
    margin-left: auto;
    flex-shrink: 0;
    font-family: var(--mono);
  }
  .ct-row {
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .ct-row:hover {
    background: var(--hover);
  }
  .ct-row.sel {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .ct-row.dim .sum,
  .ct-row.dim .author,
  .ct-row.dim .date {
    opacity: 0.6;
  }
  .ct-row > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .mark {
    font-family: var(--mono);
    text-align: center;
  }
  .mark.out,
  .status.out {
    color: var(--error-fg, #f85149);
  }
  .mark.patch,
  .status.patch {
    color: var(--accent);
  }
  .mark.squash,
  .status.squash {
    color: var(--accent);
  }
  .mark.in,
  .status.in {
    color: var(--ok-fg, #3fb950);
  }
  .sha {
    font-family: var(--mono);
    color: var(--accent);
  }
  .mtag {
    font-size: 0.8em;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 4px;
    margin-right: 5px;
    color: var(--muted);
  }
  .author,
  .date {
    color: var(--muted);
  }
  .ct-sub,
  .ct-note {
    padding: 3px 10px 3px 34px;
    color: var(--muted);
    font-style: italic;
    border-bottom: 1px solid var(--border);
  }
  .ct-note.error {
    color: var(--error-fg, #f85149);
    font-style: normal;
  }
  .ct-more {
    width: 100%;
    padding: 4px 10px 4px 34px;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--accent);
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .ct-more:disabled {
    color: var(--muted);
    cursor: default;
  }
</style>
