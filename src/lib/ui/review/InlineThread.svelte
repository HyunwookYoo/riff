<script lang="ts">
  import { reviewState, reloadDetail, writeRecord } from "$lib/review/reviewState.svelte";
  import { addItem } from "$lib/review/draft";
  import { setThreadResolved } from "$lib/review/github";
  import Composer from "./Composer.svelte";
  import InlineDraft from "./InlineDraft.svelte";
  import { textStash } from "./composerAt";

  let { threadId }: { threadId: string } = $props();

  const thread = $derived(reviewState.detail?.threads.find((t) => t.id === threadId));
  const replies = $derived(
    (reviewState.record?.items ?? []).filter(
      (i) => i.target.kind === "reply" && i.target.threadId === threadId,
    ),
  );
  // svelte-ignore state_referenced_locally
  const replyKey = `reply:${threadId}`;
  // Reopen a reply box that was open when the widget was last drawn.
  let replying = $state(textStash.has(replyKey));
  let showResolved = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function addReply(body: string) {
    const r = reviewState.record;
    const last = thread?.comments.at(-1);
    if (!r) return false;
    const preview = (last?.body ?? "").slice(0, 80);
    await writeRecord(addItem(r, { kind: "reply", threadId, preview }, body, "mine"));
    replying = false;
    return true;
  }

  async function toggleResolved() {
    const t = thread;
    const host = reviewState.prs.find((p) => p.key === reviewState.selectedKey)?.repo.host;
    if (!t || !host) return;
    busy = true;
    error = null;
    try {
      await setThreadResolved(host, t.id, !t.isResolved);
      await reloadDetail();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if thread}
  <div class="thread" class:resolved={thread.isResolved}>
    <div class="head">
      {#if thread.isResolved}
        <button type="button" class="link" onclick={() => (showResolved = !showResolved)}>
          {showResolved ? "▾" : "▸"} Resolved · {thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}
        </button>
      {:else}
        <span class="count">{thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}</span>
      {/if}
      {#if thread.isOutdated}<span class="tag">outdated</span>{/if}
      <span class="spacer"></span>
      <button type="button" onclick={() => void toggleResolved()} disabled={busy}>
        {thread.isResolved ? "Unresolve" : "Resolve"}
      </button>
    </div>
    {#if !thread.isResolved || showResolved}
      {#each thread.comments as c (c.id)}
        <div class="comment">
          <div class="meta"><b>{c.author}</b> · {new Date(c.createdAt).toLocaleString()}</div>
          <pre class="body">{c.body}</pre>
        </div>
      {/each}
      {#each replies as r (r.id)}
        <InlineDraft itemId={r.id} />
      {/each}
      {#if replying}
        <Composer label="Reply" stashKey={replyKey} onsubmit={addReply} oncancel={() => (replying = false)} />
      {:else}
        <div class="actions">
          <button type="button" onclick={() => (replying = true)} disabled={!reviewState.record}>Reply</button>
        </div>
      {/if}
    {/if}
    {#if error}<div class="error">{error}</div>{/if}
  </div>
{/if}

<style>
  .thread {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bar-bg);
  }
  .thread.resolved {
    opacity: 0.85;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
  }
  .count {
    color: var(--muted);
  }
  .tag {
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .spacer {
    flex: 1;
  }
  .link {
    border: none;
    background: transparent;
    padding: 0;
    color: var(--muted);
    cursor: pointer;
  }
  .comment {
    border-top: 1px solid var(--border);
    padding-top: 4px;
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
  .actions {
    display: flex;
    justify-content: flex-start;
  }
  .error {
    color: var(--error-fg);
    font-size: 0.85em;
    white-space: pre-wrap;
  }
</style>
