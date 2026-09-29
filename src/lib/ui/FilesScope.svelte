<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { isRepoVisible, rowMark, showAllChanges, squashLanded } from "$lib/branchContainment";
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

  // One visible group whose squash check put everything in base: say so on the
  // all-changes line, since the three-dot diff still lists every change.
  const allLanded = $derived.by(() => {
    const idx = appState.repoRanges.findIndex((r, i) => r.ok && isRepoVisible(i));
    const g = visibleOk.length === 1 && idx >= 0 ? appState.bcGroups[idx] : undefined;
    return g ? squashLanded(g) : null;
  });

  const picked = $derived.by(() => {
    const sel = appState.bcSelected;
    if (!sel) return null;
    const g = appState.bcGroups[sel.repoIdx];
    const range = appState.repoRanges[sel.repoIdx];
    if (!g || !range?.ok) return null;
    const landed = squashLanded(g);
    const mark = rowMark(
      sel.commit.sha,
      new Set(g.marks?.not_in_target ?? []),
      new Set(g.marks?.equivalent ?? []),
      !!landed,
    );
    return {
      sha: sel.commit.short_sha,
      repo: appState.repos[sel.repoIdx]?.displayName ?? "",
      state: commitStateText(mark, sideNames(range, pair), appState.bcSelectedDetail, landed),
    };
  });
</script>

{#if visibleOk.length > 0}
  <div class="files-scope">
    {#if picked}
      <span class="what">
        <b>Commit {picked.sha}</b> · {picked.repo}{#if picked.state} — {picked.state}{/if}
      </span>
      <button type="button" onclick={showAllChanges}>× All changes</button>
    {:else}
      <span class="what">{allChangesText(allNames, allLanded)}</span>
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
