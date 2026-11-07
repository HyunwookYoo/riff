import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { appState } from "../store.svelte";
import { showToast } from "../ui/toast";
import { submittable } from "./draft";
import {
  DRAFTS_LABEL,
  loadRecord,
  saveRecord,
  SUBMIT_REPLY_EVENT,
  SUBMIT_REQUEST_EVENT,
  type SubmitReply,
  type SubmitRequest,
} from "./draftStore";
import { reloadDetail, reviewState } from "./reviewState.svelte";
import {
  pendingChoices,
  removeSubmitted,
  submit,
  submitBlock,
  submitErrorMessage,
  type PendingChoice,
} from "./submit";
import type { PrKey, PrRecord, ReviewEvent } from "./types";

export const NOT_OPEN = "Open this PR in riff's PR Review (main window) to submit it.";

class SubmitFlow {
  busy = $state(false);
  error = $state<string | null>(null);
  /** An open PendingReviewDialog; "add" is absent when the web review is pinned elsewhere. */
  dialog = $state<{ choices: PendingChoice[] } | null>(null);
}

export const submitFlow = new SubmitFlow();

let answer: ((c: PendingChoice | null) => void) | null = null;

/** The PendingReviewDialog's answer; null = Cancel. */
export function answerPending(c: PendingChoice | null): void {
  const a = answer;
  answer = null;
  submitFlow.dialog = null;
  a?.(c);
}

function askPending(choices: PendingChoice[]): Promise<PendingChoice | null> {
  submitFlow.dialog = { choices };
  // A request from the drafts window: the dialog is here.
  void getCurrentWebviewWindow().setFocus().catch(() => {});
  return new Promise((resolve) => (answer = resolve));
}

/**
 * The only submit path (main window; the drafts window asks through
 * SUBMIT_REQUEST_EVENT). Needs the PR open in review mode here: it pins to the
 * displayed head. Resolves to a message for the requester; never throws.
 */
export async function runSubmit(key: PrKey, edits: { event: ReviewEvent; body: string }): Promise<string> {
  const s = reviewState;
  if (submitFlow.busy) return "A submit is already running.";
  if (appState.appMode !== "review" || s.selectedKey !== key) return NOT_OPEN;
  const summary = s.prs.find((p) => p.key === key);
  const head = s.headSha;
  const detail = s.detail;
  if (!summary || !head || !detail || !s.record) return s.error ?? "This PR is still loading.";
  if (s.headMoved) return submitErrorMessage(new Error("submit-blocked:not-seen"));

  submitFlow.busy = true;
  submitFlow.error = null;
  try {
    let start: PrRecord;
    try {
      // The stored record, not the in-memory one: the other window may have saved since.
      start = { ...(await loadRecord(key)), event: edits.event, body: edits.body };
      const block = submitBlock(start, head);
      if (block) throw new Error(`submit-blocked:${block}`);
      const choices = pendingChoices(detail.pendingReviewId, detail.pendingReviewCommit, head);
      const choice = choices ? await askPending(choices) : null;
      if (choices && !choice) return "Submit cancelled.";
      if (s.selectedKey !== key || s.headSha !== head) return "The PR changed; nothing was submitted.";
      await submit({
        host: summary.repo.host,
        prNodeId: summary.nodeId,
        headSha: head,
        record: start,
        existingPendingId: detail.pendingReviewId,
        existingPendingCommit: detail.pendingReviewCommit,
        choice,
      });
    } catch (e) {
      const msg = submitErrorMessage(e);
      submitFlow.error = msg;
      showToast(msg);
      return msg; // the draft is untouched
    }

    // Edits made in either window during the submit stay: drop only what was sent.
    const sent = submittable(start).map((i) => i.id);
    try {
      const next = removeSubmitted(await loadRecord(key), sent);
      await saveRecord(next);
      if (s.selectedKey === key && s.record) s.record = next;
    } catch (e) {
      const msg = `Review submitted, but the draft could not be updated (${e}). Remove the submitted comments before submitting again.`;
      submitFlow.error = msg;
      showToast("Review submitted");
      void reloadDetail().catch(() => {});
      return msg;
    }
    showToast("Review submitted");
    void reloadDetail().catch(() => {});
    return "Review submitted";
  } finally {
    submitFlow.busy = false;
  }
}

/** Main window: serve the drafts window's submit requests. */
export function listenSubmitRequests(): Promise<() => void> {
  return listen<SubmitRequest>(SUBMIT_REQUEST_EVENT, async (e) => {
    const { key, event, body } = e.payload;
    const message = await runSubmit(key, { event, body });
    const reply: SubmitReply = { key, message };
    await emitTo(DRAFTS_LABEL, SUBMIT_REPLY_EVENT, reply).catch(() => {});
  });
}
