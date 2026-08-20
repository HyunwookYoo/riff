<script lang="ts">
  import { appState } from "$lib/store.svelte";

  // The commit currently selected in the graph. The synthetic WIP node is never
  // a real selection (clicking it jumps to Changes), so a lookup miss just means
  // "nothing selected yet" — render the empty state.
  const commit = $derived(
    appState.selectedCommitSha
      ? (appState.commits.find((c) => c.sha === appState.selectedCommitSha) ??
        null)
      : null,
  );

  // Absolute timestamp — the graph row already shows a relative "2d ago", so the
  // detail pane complements it with the precise date/time.
  function fullDate(unixSec: number): string {
    return new Date(unixSec * 1000).toLocaleString();
  }
</script>

{#if commit}
  <section class="commit-detail">
    <p class="cd-subject">{commit.summary}</p>
    <dl class="cd-meta">
      <dt>author</dt>
      <dd>{commit.author} · {fullDate(commit.time)}</dd>
      <dt>sha</dt>
      <dd>{commit.sha}</dd>
      {#if commit.parents.length > 0}
        <dt>parents</dt>
        <dd>{commit.parents.map((p) => p.slice(0, 8)).join(" · ")}</dd>
      {/if}
    </dl>
    {#if commit.body}
      <pre class="cd-body">{commit.body}</pre>
    {/if}
  </section>
{:else}
  <div class="cd-empty">Select a commit to see its message.</div>
{/if}

<style>
  /* The panel's Commit tab. Owns the full pane and scrolls on its own, so a
     long message never pushes the graph or the Files tab around. */
  .commit-detail {
    height: 100%;
    overflow-y: auto;
    padding: 10px 14px;
    user-select: text;
  }
  .cd-subject {
    margin: 0 0 8px;
    font-weight: 600;
    font-size: 0.92em;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cd-meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 14px;
    margin: 0 0 10px;
    font-family: var(--mono);
    font-size: 0.72em;
  }
  .cd-meta dt {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .cd-meta dd {
    margin: 0;
    color: var(--fg);
    opacity: 0.85;
    word-break: break-all;
  }
  /* Preserve the body's own line breaks; wrap long lines rather than scroll
     horizontally. */
  .cd-body {
    margin: 0;
    font-family: var(--mono);
    font-size: 0.8em;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg);
    opacity: 0.85;
  }
  .cd-empty {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 0.9em;
  }
</style>
