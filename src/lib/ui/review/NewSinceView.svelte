<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { markNewSinceSeen, reviewState } from "$lib/review/reviewState.svelte";
  import DiffView from "../DiffView.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let selected = $state<string | null>(reviewState.newSinceFiles[0] ?? null);
  let closing = $state(false);

  const summary = $derived(reviewState.prs.find((p) => p.key === reviewState.selectedKey));
  const repoPath = $derived(summary ? appState.repos[summary.repoIdx]?.path : undefined);
  // viewedHead..displayed head. After an author rebase this also shows upstream
  // edits to the same files; accepted.
  const source = $derived(
    repoPath && selected && reviewState.record?.viewedHead && reviewState.headSha
      ? {
          repoPath,
          start: reviewState.record.viewedHead,
          target: reviewState.headSha,
          file: { path: selected, old_path: null, status: "modified" as const, repoIdx: summary!.repoIdx },
          mode: "two-dot" as const,
        }
      : undefined,
  );

  async function close() {
    closing = true;
    try {
      await markNewSinceSeen();
    } catch (e) {
      reviewState.error = `Couldn't mark the new commits as seen: ${e}`;
    } finally {
      closing = false;
      onclose();
    }
  }
</script>

<div class="new-since-view">
  <div class="head">
    <span class="title">New since you looked</span>
    <span class="spacer"></span>
    <button type="button" onclick={() => void close()} disabled={closing}>
      {closing ? "Marking seen…" : "Done: mark as seen"}
    </button>
  </div>
  <div class="cols">
    <ul class="files">
      {#each reviewState.newSinceFiles as path (path)}
        <li>
          <button type="button" class:active={path === selected} onclick={() => (selected = path)}>
            {path}
          </button>
        </li>
      {:else}
        <li class="empty">No file changes since you looked.</li>
      {/each}
    </ul>
    <div class="diff">
      {#if source}
        <DiffView {source} />
      {:else}
        <div class="placeholder">No file selected</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .new-since-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
  }
  .title {
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .cols {
    display: grid;
    grid-template-columns: 260px 1fr;
    flex: 1;
    min-height: 0;
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    border-right: 1px solid var(--border);
  }
  .files button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 3px 10px;
    border: none;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    font-family: var(--mono);
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .files button.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .empty {
    padding: 6px 10px;
    color: var(--muted);
  }
  .diff {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .placeholder {
    margin: auto;
    color: var(--muted);
  }
  .head button {
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.85em;
  }
</style>
