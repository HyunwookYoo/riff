<script lang="ts">
  import { reviewState } from "$lib/review/reviewState.svelte";
  import { viewerLogin } from "$lib/review/github";
  import CommentItem from "./CommentItem.svelte";

  /** `full`: shown as its own tab — always open, no height cap. */
  let { full = false }: { full?: boolean } = $props();

  const summary = $derived(reviewState.prs.find((p) => p.key === reviewState.selectedKey));
  const detail = $derived(reviewState.detail);
  let collapsed = $state(false);
  const open = $derived(full || !collapsed);

  let viewer = $state<string | null>(null);
  $effect(() => {
    const host = summary?.repo.host;
    if (!host) return;
    let live = true;
    viewerLogin(host)
      .then((l) => {
        if (live) viewer = l;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  });
</script>

{#if detail}
  <section class="overview" class:full>
    {#snippet heading()}
      {#if summary}<span class="title">#{summary.number} {summary.title}</span>{/if}
      <span class="muted">
        {detail.conversation.length} comment{detail.conversation.length === 1 ? "" : "s"}
      </span>
    {/snippet}
    {#if full}
      <div class="head">{@render heading()}</div>
    {:else}
      <button type="button" class="head" onclick={() => (collapsed = !collapsed)}>
        <span>{open ? "▾" : "▸"}</span>
        {@render heading()}
      </button>
    {/if}
    {#if open}
      <div class="content">
        {#if summary}
          <CommentItem
            author={summary.author}
            createdAt={null}
            body={detail.body.trim() ? detail.body : "(No description.)"}
            prAuthor={summary.author}
            {viewer}
          />
        {:else if detail.body.trim()}
          <pre class="body">{detail.body}</pre>
        {/if}
        {#each detail.conversation as c (c.id)}
          <CommentItem author={c.author} createdAt={c.createdAt} body={c.body} prAuthor={summary?.author ?? null} {viewer} />
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
  .full {
    border-bottom: none;
    background: transparent;
  }
  .full .head {
    cursor: default;
    color: inherit;
    padding: 8px 12px 2px;
    font-size: 1.05em;
  }
  .full .content {
    max-height: none;
    overflow: visible;
    padding: 4px 12px 12px;
  }
  .body {
    margin: 2px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
  }
</style>
