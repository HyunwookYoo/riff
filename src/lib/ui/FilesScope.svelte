<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { isRepoVisible, rowMark, showAllChanges } from "$lib/branchContainment";
  import { shortRef, sideNames } from "$lib/rangeText";
  import { allChangesText, commitStateText } from "$lib/commitTableText";

  // The line above the file list: what the list holds — every change of the
  // range on screen, or one picked commit and how it stands against base.
  const pair = $derived({
    base: appState.startBranch,
    compare: appState.targetBranch,
  });
  const visibleOk = $derived(
    appState.repoRanges.flatMap((r, i) => (r.ok && isRepoVisible(i) ? [r] : [])),
  );
  const allNames = $derived(
    visibleOk.length === 1
      ? sideNames(visibleOk[0], pair)
      : { base: shortRef(pair.base), compare: shortRef(pair.compare) },
  );

  const picked = $derived.by(() => {
    const sel = appState.bcSelected;
    if (!sel) return null;
    const g = appState.bcGroups[sel.repoIdx];
    const range = appState.repoRanges[sel.repoIdx];
    if (!g || !range?.ok) return null;
    const mark = rowMark(
      sel.commit.sha,
      new Set(g.marks?.not_in_target ?? []),
      new Set(g.marks?.equivalent ?? []),
    );
    return {
      sha: sel.commit.short_sha,
      repo: appState.repos[sel.repoIdx]?.displayName ?? "",
      state: commitStateText(mark, sideNames(range, pair), appState.bcSelectedDetail),
    };
  });
</script>

{#if visibleOk.length > 0}
  <div class="files-scope">
    {#if picked}
      <span class="what">
        <b>Commit {picked.sha}</b> · {picked.repo} — {picked.state}
      </span>
      <button type="button" onclick={showAllChanges}>× All changes</button>
    {:else}
      <span class="what">{allChangesText(allNames)}</span>
    {/if}
  </div>
{/if}

<style>
  .files-scope {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    font-size: 0.8em;
    white-space: nowrap;
  }
  .what {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
  }
  button {
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    padding: 1px 6px;
    font: inherit;
  }
  button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
