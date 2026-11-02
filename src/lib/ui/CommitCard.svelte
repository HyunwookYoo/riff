<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { commitViewFileCount } from "$lib/history";
  import { relativeDate } from "./relativeDate";

  // The commit view's card, in the commit table's pane: the commit a Blame
  // drill-in opened. A body past BODY_FOLD_LINES folds.
  const BODY_FOLD_LINES = 6;
  let expanded = $state(false);

  const commit = $derived(appState.commitView?.commit ?? null);
  const folds = $derived(
    !!commit?.body && commit.body.split("\n").length > BODY_FOLD_LINES,
  );
  const fileCount = $derived(commitViewFileCount());

  // Another commit starts folded.
  $effect(() => {
    void commit?.sha;
    expanded = false;
  });

  function fullDate(unixSec: number): string {
    return new Date(unixSec * 1000).toLocaleString();
  }
</script>

{#if commit}
  <section class="commit-card">
    <p class="cc-subject">{commit.summary || "(no subject)"}</p>
    <div class="cc-meta">
      <b>{commit.author}</b>
      <span>{fullDate(commit.time)} ({relativeDate(commit.time)})</span>
      {#if commit.parents.length === 0}
        <span>first commit</span>
      {:else if commit.parents.length > 1}
        <span>merge · {commit.parents.length} parents · diff against the first parent</span>
      {:else}
        <span>parent <code>{commit.parents[0].slice(0, 8)}</code></span>
      {/if}
      <span>{fileCount} files</span>
    </div>
    {#if commit.body}
      <pre class="cc-body" class:folded={folds && !expanded}>{commit.body}</pre>
      {#if folds}
        <button type="button" class="cc-more" onclick={() => (expanded = !expanded)}>
          {expanded ? "Show less ▴" : "Show full message ▾"}
        </button>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .commit-card {
    height: 100%;
    overflow-y: auto;
    padding: 10px 14px;
    user-select: text;
  }
  .cc-subject {
    margin: 0 0 6px;
    font-weight: 600;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cc-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 0.82em;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .cc-meta b {
    color: var(--fg);
  }
  code {
    font-family: var(--mono);
  }
  .cc-body {
    margin: 0;
    font-family: inherit;
    font-size: 0.86em;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cc-body.folded {
    max-height: calc(6 * 1.5em);
    overflow: hidden;
    -webkit-mask-image: linear-gradient(#000 60%, transparent);
    mask-image: linear-gradient(#000 60%, transparent);
  }
  .cc-more {
    margin-top: 4px;
    border: none;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 0.82em;
    padding: 0;
    cursor: pointer;
  }
  .cc-more:hover {
    text-decoration: underline;
  }
</style>
