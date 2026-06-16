<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    loadBranchContainment,
    loadMoreBranchCommits,
    selectBranchCommit,
  } from "$lib/branchContainment";

  // Reload the marked list + marks whenever the compare refs (or repo) change.
  // Only the diff (bottom) waits for an explicit row / Compare click.
  $effect(() => {
    void appState.startBranch;
    void appState.targetBranch;
    void appState.repoPath;
    if (appState.appMode === "compare") void loadBranchContainment();
  });

  // Membership sets for O(1) per-row marks against the target.
  const notInSet = $derived(
    appState.containment ? new Set(appState.containment.not_in_target) : null,
  );
  const equivSet = $derived(
    appState.containment ? new Set(appState.containment.equivalent) : null,
  );
  type CState = "in" | "equiv" | "out";
  function cstate(sha: string): CState | null {
    if (!notInSet) return null;
    if (equivSet?.has(sha)) return "equiv";
    if (notInSet.has(sha)) return "out";
    return "in";
  }
  function cTitle(cs: CState): string {
    const t = appState.targetBranch;
    if (cs === "out") return `Not yet in ${t}`;
    if (cs === "equiv") return `Already applied in ${t} (rebase / cherry-pick)`;
    return `In ${t}`;
  }

  // `out` is the genuine ● count: source-only commits minus the patch-
  // equivalents already applied in target.
  const summary = $derived.by(() => {
    const c = appState.containment;
    if (!c) return null;
    const equiv = c.equivalent.length;
    const out = c.source_is_branch
      ? Math.max(0, c.ahead - equiv)
      : c.not_in_target.length;
    return { out, equiv, ahead: c.ahead, behind: c.behind };
  });

  const detail = $derived(appState.containmentDetail);

  function fmtDate(unixSec: number): string {
    const d = new Date(unixSec * 1000);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function onScroll(e: Event) {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
      void loadMoreBranchCommits();
    }
  }
</script>

<div class="bc">
  {#if !appState.startBranch || !appState.targetBranch}
    <div class="bc-empty">Pick a start and target branch to check containment.</div>
  {:else}
    <div class="bc-summary">
      <span class="src" title="Your branch (start)">{appState.startBranch}</span>
      <span class="arrow">→</span>
      <span class="tgt" title="Target">{appState.targetBranch}</span>
      {#if summary}
        {#if summary.out > 0}
          <span class="tag out">● {summary.out} not in {appState.targetBranch}</span>
        {:else}
          <span class="tag allin">✓ fully in {appState.targetBranch}</span>
        {/if}
        {#if summary.equiv > 0}
          <span class="tag equiv" title="Already applied as an equivalent patch (rebase / cherry-pick)">
            ◐ {summary.equiv} applied
          </span>
        {/if}
        <span class="ab" title="ahead / behind">↑{summary.ahead} ↓{summary.behind}</span>
      {/if}
      {#if appState.loadingContainment}<span class="loading">…</span>{/if}
    </div>

    <div class="bc-list" onscroll={onScroll}>
      <button
        type="button"
        class="bc-row all"
        class:sel={appState.bcSelectedSha === null}
        onclick={() => selectBranchCommit(null)}
        title="Show every file changed between {appState.startBranch} and {appState.targetBranch}"
      >
        <span class="glyph">◆</span>
        <span class="sum">All changes</span>
      </button>
      {#each appState.bcCommits as commit (commit.sha)}
        {@const cs = cstate(commit.sha)}
        <button
          type="button"
          class="bc-row"
          class:sel={appState.bcSelectedSha === commit.sha}
          class:dim={cs === "in"}
          onclick={() => selectBranchCommit(commit)}
          title={commit.summary}
        >
          {#if cs}
            <span class="mark {cs}" title={cTitle(cs)}>{cs === "out" ? "●" : "✓"}</span>
          {/if}
          <span class="sum">{commit.summary}</span>
          <span class="sha">{commit.short_sha}</span>
        </button>
      {/each}
      {#if appState.bcLoadingCommits}
        <div class="bc-note">…</div>
      {:else if appState.bcCommits.length === 0}
        <div class="bc-note">No commits on {appState.startBranch}.</div>
      {/if}
    </div>

    {#if detail && appState.bcSelectedSha}
      <div class="bc-detail">
        <div class="d-status" class:in={detail.in_target} class:out={!detail.in_target}>
          {#if detail.in_target}✓ In {appState.targetBranch}{:else}● Not in {appState.targetBranch}{/if}
        </div>
        {#if detail.introduced_by}
          {@const m = detail.introduced_by}
          <button
            type="button"
            class="d-intro"
            onclick={() => selectBranchCommit(m)}
            title="Show the introducing merge commit"
          >
            <span class="d-label">via</span>
            <span class="d-sha">{m.short_sha}</span>
            <span class="d-sum">{m.summary}</span>
            <span class="d-date">{fmtDate(m.time)}</span>
          </button>
        {:else if detail.in_target}
          <div class="d-note">fast-forwarded / committed directly — no merge commit</div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .bc {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  .bc-empty,
  .bc-note {
    padding: 10px 12px;
    color: var(--muted);
    font-size: 0.82em;
  }
  .bc-note {
    text-align: center;
    padding: 8px;
    font-size: 0.78em;
  }
  .bc-summary {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    font-size: 0.78em;
    font-family: var(--mono);
  }
  .bc-summary .src {
    font-weight: 600;
  }
  .bc-summary .tgt {
    font-weight: 600;
    color: var(--accent);
  }
  .bc-summary .arrow {
    opacity: 0.6;
  }
  .bc-summary .tag {
    padding: 0 6px;
    border-radius: 8px;
    border: 1px solid transparent;
  }
  .bc-summary .tag.out {
    color: var(--error-fg, #f85149);
    border-color: var(--error-fg, #f85149);
  }
  .bc-summary .tag.allin {
    color: var(--ok-fg, #3fb950);
    border-color: var(--ok-fg, #3fb950);
  }
  .bc-summary .tag.equiv {
    color: var(--accent);
    border-color: var(--accent);
  }
  .bc-summary .ab {
    margin-left: auto;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .bc-summary .loading {
    color: var(--muted);
  }
  .bc-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .bc-row {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 4px 10px;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 0.84em;
  }
  .bc-row:hover {
    background: var(--hover);
  }
  .bc-row.sel {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .bc-row.dim .sum {
    opacity: 0.6;
  }
  .bc-row.all {
    font-weight: 600;
  }
  .bc-row.all .glyph {
    color: var(--accent);
    flex: 0 0 auto;
  }
  .bc-row .mark {
    flex: 0 0 auto;
    width: 1em;
    text-align: center;
    font-family: var(--mono);
  }
  .bc-row .mark.out {
    color: var(--error-fg, #f85149);
  }
  .bc-row .mark.in {
    color: var(--ok-fg, #3fb950);
    opacity: 0.7;
  }
  .bc-row .mark.equiv {
    color: var(--accent);
  }
  .bc-row .sum {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bc-row .sha {
    flex: 0 0 auto;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 0.85em;
  }
  .bc-detail {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 7px 10px;
    border-top: 1px solid var(--border);
    background: var(--bar-bg);
    font-size: 0.78em;
  }
  .bc-detail .d-status {
    font-weight: 600;
  }
  .bc-detail .d-status.in {
    color: var(--ok-fg, #3fb950);
  }
  .bc-detail .d-status.out {
    color: var(--error-fg, #f85149);
  }
  .bc-detail .d-label {
    color: var(--muted);
    text-transform: uppercase;
    font-size: 0.82em;
    letter-spacing: 0.04em;
  }
  .d-intro {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: 1em;
    text-align: left;
    font-family: var(--mono);
  }
  .d-intro:hover {
    border-color: var(--accent);
  }
  .d-intro .d-sha {
    color: var(--accent);
    flex: 0 0 auto;
  }
  .d-intro .d-sum {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .d-intro .d-date {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 0.9em;
  }
  .d-note {
    color: var(--muted);
    font-style: italic;
  }
</style>
