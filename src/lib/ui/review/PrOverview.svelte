<script lang="ts">
  import { reviewState } from "$lib/review/reviewState.svelte";

  const summary = $derived(reviewState.prs.find((p) => p.key === reviewState.selectedKey));
  const detail = $derived(reviewState.detail);
  let open = $state(true);
</script>

{#if detail}
  <section class="overview">
    <button type="button" class="head" onclick={() => (open = !open)}>
      <span>{open ? "▾" : "▸"}</span>
      {#if summary}<span class="title">#{summary.number} {summary.title}</span>{/if}
      <span class="muted">
        {detail.conversation.length} comment{detail.conversation.length === 1 ? "" : "s"}
      </span>
    </button>
    {#if open}
      <div class="content">
        {#if detail.body.trim()}
          <pre class="body">{detail.body}</pre>
        {:else}
          <div class="muted">No description.</div>
        {/if}
        {#each detail.conversation as c (c.id)}
          <div class="comment">
            <div class="meta"><b>{c.author}</b> · {new Date(c.createdAt).toLocaleString()}</div>
            <pre class="body">{c.body}</pre>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .overview {
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 4px 10px;
    border: none;
    border-radius: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85em;
  }
  .content {
    max-height: 35vh;
    overflow-y: auto;
    padding: 4px 10px 8px;
  }
  .comment {
    border-top: 1px solid var(--border);
    padding-top: 4px;
    margin-top: 6px;
  }
  .meta {
    color: var(--muted);
    font-size: 0.85em;
  }
  .body {
    margin: 2px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
  }
</style>
