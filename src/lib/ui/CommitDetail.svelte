<script lang="ts">
  import { appState } from "$lib/store.svelte";

  // The commit currently selected in the graph. The synthetic WIP node is never
  // a real selection (clicking it jumps to Changes), so a lookup miss just means
  // "nothing selected yet" — render nothing.
  const commit = $derived(
    appState.selectedCommitSha
      ? (appState.commits.find((c) => c.sha === appState.selectedCommitSha) ??
        null)
      : null,
  );

  // Absolute timestamp — the graph row already shows a relative "2d ago", so the
  // detail panel complements it with the precise date/time.
  function fullDate(unixSec: number): string {
    return new Date(unixSec * 1000).toLocaleString();
  }
</script>

{#if commit}
  <section class="commit-detail">
    <p class="cd-subject">{commit.summary}</p>
    {#if commit.body}
      <pre class="cd-body">{commit.body}</pre>
    {/if}
    <div class="cd-meta">
      <span class="cd-sha">{commit.short_sha}</span>
      {#if commit.author}<span class="cd-author">{commit.author}</span>{/if}
      <span class="cd-date">{fullDate(commit.time)}</span>
    </div>
  </section>
{/if}

<style>
  /* Sits at the top of the graph-detail column, above the file list. Caps its
     own height and scrolls so a long body can't crowd out the files + diff. */
  .commit-detail {
    flex: 0 0 auto;
    max-height: 28%;
    overflow-y: auto;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar-bg);
    user-select: text;
  }
  .cd-subject {
    margin: 0 0 6px;
    font-weight: 600;
    font-size: 0.9em;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Preserve the body's own line breaks; wrap long lines rather than scroll
     horizontally. */
  .cd-body {
    margin: 0 0 8px;
    font-family: var(--mono);
    font-size: 0.8em;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg);
    opacity: 0.85;
  }
  .cd-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 0.72em;
    color: var(--muted);
  }
  .cd-sha {
    color: var(--accent);
  }
  .cd-author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 50%;
  }
</style>
