<script lang="ts">
  import { onDestroy } from "svelte";
  import { reviewState, writeRecord } from "$lib/review/reviewState.svelte";
  import { openDraftsWindow } from "$lib/review/draftStore";
  import { setEvent } from "$lib/review/draft";
  import { submitBlock } from "$lib/review/submit";
  import { answerPending, draftLocked, runSubmit, submitFlow } from "$lib/review/submitFlow.svelte";
  import type { ReviewEvent } from "$lib/review/types";
  import { showToast } from "../toast";
  import PendingReviewDialog from "./PendingReviewDialog.svelte";

  let { onnewsince }: { onnewsince: () => void } = $props();

  const record = $derived(reviewState.record);
  const block = $derived(
    record && reviewState.headSha ? submitBlock(record, reviewState.headSha) : null,
  );
  // The displayed head is behind what was seen, or the PR moved past it.
  const notSeen = $derived(block === "not-seen" || !!reviewState.headMoved);
  const canSubmit = $derived(!!record && !block && !reviewState.headMoved && !submitFlow.busy);
  // A submit is sending this draft: it is read-only here and in the drafts window.
  const locked = $derived(draftLocked());

  // Leaving the PR (or review mode) cancels an unanswered pending-review dialog.
  onDestroy(() => {
    if (submitFlow.dialog) answerPending(null);
  });

  function chooseEvent(event: ReviewEvent) {
    if (record) void writeRecord(setEvent(record, event));
  }

  function openDrafts() {
    const key = reviewState.selectedKey;
    if (key) openDraftsWindow(key).catch((e) => showToast(`Couldn't open the drafts window: ${e}`));
  }

  function doSubmit() {
    const key = reviewState.selectedKey;
    if (key && record) void runSubmit(key, { event: record.event, body: record.body });
  }
</script>

{#if notSeen}
  <div class="new-since">
    <span>New commits since you looked: review them first</span>
    <button type="button" onclick={onnewsince}>New since you looked</button>
  </div>
{/if}
{#if submitFlow.error}
  <div class="submit-error">
    <span>{submitFlow.error}</span>
    <button type="button" aria-label="Dismiss" onclick={() => (submitFlow.error = null)}>×</button>
  </div>
{/if}
<div class="review-bar">
  <button type="button" class="drafts" onclick={openDrafts} disabled={!reviewState.selectedKey || locked}>
    My draft: {record?.items.length ?? 0} comment{record?.items.length === 1 ? "" : "s"}
  </button>
  <span class="spacer"></span>
  <select
    value={record?.event ?? "COMMENT"}
    disabled={!record || locked}
    onchange={(e) => chooseEvent(e.currentTarget.value as ReviewEvent)}
    aria-label="Review event"
  >
    <option value="COMMENT">Comment</option>
    <option value="APPROVE">Approve</option>
    <option value="REQUEST_CHANGES">Request changes</option>
  </select>
  <button
    type="button"
    class="primary"
    disabled={!canSubmit}
    title={block === "empty" ? "Nothing to submit" : notSeen ? "Review the new commits first" : ""}
    onclick={doSubmit}
  >
    {submitFlow.busy ? "Submitting…" : "Submit to GitHub"}
  </button>
</div>
<PendingReviewDialog />

<style>
  .review-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .spacer {
    flex: 1;
  }
  button,
  select {
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    font-size: 0.85em;
  }
  button:not(:disabled) {
    cursor: pointer;
  }
  .drafts {
    border-color: transparent;
    background: transparent;
    color: var(--accent);
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  button:disabled,
  select:disabled {
    opacity: 0.5;
  }
  .new-since,
  .submit-error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
  }
  .new-since {
    background: var(--accent-soft);
  }
  .new-since span,
  .submit-error span {
    flex: 1;
  }
  .submit-error {
    background: var(--error-bg);
    color: var(--error-fg);
    white-space: pre-wrap;
  }
</style>
