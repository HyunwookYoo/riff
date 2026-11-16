<script lang="ts">
  import { reviewState, reloadDetail, writeRecord } from "$lib/review/reviewState.svelte";
  import { addItem } from "$lib/review/draft";
  import { setThreadResolved, viewerLogin } from "$lib/review/github";
  import { draftLocked } from "$lib/review/submitFlow.svelte";
  import Composer from "./Composer.svelte";
  import InlineDraft from "./InlineDraft.svelte";
  import CommentItem from "./CommentItem.svelte";
  import { textStash } from "./composerAt";
  import { aiState } from "$lib/review/ai/aiState.svelte";
  import { verdictLabel } from "$lib/review/ai/rereview";
  import { checkLabel, hasAiReply } from "$lib/review/ai/threadCheck";
  import type { CheckedEvidence } from "$lib/review/ai/types";
  import type { DraftOrigin, GhRepo, ReviewThread, Side } from "$lib/review/types";
  import TraceList from "./TraceList.svelte";
  import ThreadCheckReply from "./ThreadCheckReply.svelte";
  import { ownThreadResolved, recordReaction } from "$lib/review/ai/memory";

  let { threadId, onevidence }: {
    threadId: string;
    /** Select `path` and reveal `line` (null: just the file) on `side` (default RIGHT). */
    onevidence?: (path: string, line: number | null, side?: Side) => void;
  } = $props();

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
  let verdictOpen = $state(false);
  const ai = $derived(reviewState.selectedKey ? aiState.results[reviewState.selectedKey] : undefined);
  // A thread check replaces the old re-review verdict of the same thread.
  const check = $derived(ai?.threadChecks?.[threadId]);
  const status = $derived(thread && !thread.isResolved && check ? checkLabel(check, reviewState.headSha, thread) : null);
  const added = $derived(hasAiReply(replies, threadId));
  const rereview = $derived(ai?.rereview);
  const verdict = $derived(check ? undefined : rereview?.verdicts.find((v) => v.threadId === threadId));
  const label = $derived(thread && !thread.isResolved ? verdictLabel(verdict, rereview?.toHead !== reviewState.headSha) : null);
  const inPr = (path: string) => reviewState.files.some((x) => x.path === path);
  const where = (path: string, line: number | null) => (line !== null ? `${path}:${line}` : path);
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Who wrote what: badge the PR author and the viewer on each comment.
  const summary = $derived(reviewState.prs.find((p) => p.key === reviewState.selectedKey));
  const prAuthor = $derived(summary?.author ?? null);
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

  async function writeReply(body: string, origin: DraftOrigin) {
    const r = reviewState.record;
    const last = thread?.comments.at(-1);
    if (!r) return false;
    const preview = (last?.body ?? "").slice(0, 80);
    await writeRecord(addItem(r, { kind: "reply", threadId, preview }, body, origin));
    return true;
  }

  async function addReply(body: string) {
    if (!(await writeReply(body, "mine"))) return false;
    replying = false;
    return true;
  }

  /** Only for a thread the viewer started; skipped if their login can't be had. */
  function rememberResolved(t: ReviewThread, repo: GhRepo) {
    viewerLogin(repo.host)
      .then((login) => {
        const r = ownThreadResolved(t, login, repo);
        if (r) recordReaction(r);
      })
      .catch(() => {});
  }

  async function toggleResolved() {
    const t = thread;
    const repo = reviewState.prs.find((p) => p.key === reviewState.selectedKey)?.repo;
    if (!t || !repo) return;
    busy = true;
    error = null;
    try {
      await setThreadResolved(repo.host, t.id, !t.isResolved);
      if (!t.isResolved) rememberResolved(t, repo);
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
    {#snippet evidenceList(evidence: CheckedEvidence[])}
      <ul class="evidence">
        {#each evidence as e, i (i)}
          <li>
            <!-- A merge-base item's line is on the old side. -->
            {#if onevidence && inPr(e.path)}
              <button type="button" class="link" onclick={() => onevidence(e.path, e.line, e.base ? "LEFT" : "RIGHT")}>{where(e.path, e.line)}</button>
            {:else}
              <span class="loc">{where(e.path, e.line)}</span>
            {/if}
            {#if e.base}<span class="loc">(before this PR)</span>{/if}
            <pre class="quote">{e.quote}</pre>
          </li>
        {/each}
      </ul>
    {/snippet}
    {#if status && check}
      <div class="verdict {status.tone}">
        <button type="button" class="link" onclick={() => (verdictOpen = !verdictOpen)}>
          {verdictOpen ? "▾" : "▸"} <b>{status.text}</b> {check.point}
        </button>
        {#if verdictOpen}
          <pre class="body">{check.reason}</pre>
          {#if check.problem}<p class="note">{check.problem}</p>{/if}
          {#if check.unchecked}<p class="note">Not fully checked</p>{/if}
          {@render evidenceList(check.evidence)}
          <TraceList trace={check.trace} title="Path" {onevidence} />
          {#if check.reply}
            {#key check.createdAt}
              <ThreadCheckReply {check} stale={status.stale !== null} {added} onadd={writeReply} />
            {/key}
          {/if}
        {/if}
      </div>
    {:else if label && verdict}
      <div class="verdict {label.tone}">
        <button type="button" class="link" onclick={() => (verdictOpen = !verdictOpen)}>
          {verdictOpen ? "▾" : "▸"} <b>{label.text}</b>
        </button>
        {#if verdictOpen}
          <pre class="body">{verdict.reason}</pre>
          {@render evidenceList(verdict.evidence)}
        {/if}
      </div>
    {/if}
    {#if !thread.isResolved || showResolved}
      <div class="comments">
        {#each thread.comments as c, i (c.id)}
          <CommentItem author={c.author} createdAt={c.createdAt} body={c.body} {prAuthor} {viewer} reply={i > 0} />
        {/each}
      </div>
      {#each replies as r (r.id)}
        <InlineDraft itemId={r.id} />
      {/each}
      {#if replying}
        <Composer label="Reply" stashKey={replyKey} onsubmit={addReply} oncancel={() => (replying = false)} />
      {:else}
        <div class="actions">
          <button type="button" onclick={() => (replying = true)} disabled={!reviewState.record || draftLocked()}>Reply</button>
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
  /* Per part, not on the block: TraceList sizes its own text, and must not be shrunk twice. */
  .verdict > .link,
  .verdict > .body,
  .verdict > .note,
  .evidence {
    font-size: 0.85em;
  }
  .verdict > .link {
    text-align: left;
  }
  .note {
    margin: 2px 0 0;
    color: var(--muted);
  }
  .verdict.ok b {
    color: var(--ok-fg, #2da44e);
  }
  .verdict.warn b {
    color: var(--warn-fg, #d29922);
  }
  .verdict.muted b {
    color: var(--muted);
  }
  .evidence {
    margin: 4px 0 0;
    padding-left: 16px;
  }
  .loc {
    font-family: var(--mono);
    color: var(--muted);
  }
  .quote {
    margin: 2px 0 4px;
    padding: 2px 4px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--mono);
    background: var(--input-bg);
    border-radius: 3px;
  }
  .comments {
    border-top: 1px solid var(--border);
  }
  .body {
    margin: 2px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
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
