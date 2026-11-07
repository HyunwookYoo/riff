import { submittable } from "./draft";
import {
  pendingChoices,
  removeSubmitted,
  submitBlock,
  submitErrorMessage,
  type PendingChoice,
  type submit,
} from "./submit";
import type { PrDetail, PrKey, PrRecord, ReviewEvent } from "./types";

export const NOT_OPEN = "Open this PR in riff's PR Review (main window) to submit it.";
export const HEAD_MOVED = "New commits were pushed — review them first. Nothing was submitted.";

/** What the submit decisions read from the main window; re-read after every await. */
export interface SubmitView {
  /** The main window is in PR Review mode. */
  open: boolean;
  selectedKey: PrKey | null;
  pr: { host: string; nodeId: string } | null;
  /** The displayed head; submit pins to it. */
  headSha: string | null;
  detail: PrDetail | null;
  /** A readable record is loaded. */
  hasRecord: boolean;
  headMoved: boolean;
  error: string | null;
}

export interface SubmitDeps {
  view(): SubmitView;
  loadRecord(key: PrKey): Promise<PrRecord>;
  saveRecord(r: PrRecord): Promise<void>;
  submit: typeof submit;
  askPending(choices: PendingChoice[]): Promise<PendingChoice | null>;
  /** Show `r` as the PR's record if `key` is still the open PR. */
  adopt(key: PrKey, r: PrRecord): void;
  reloadDetail(): void;
  toast(msg: string): void;
  /** The PR's detail as GitHub has it now. */
  prDetail(host: string, nodeId: string): Promise<PrDetail>;
  /** Show `detail`, fetched for `key`, flagging a head move past `shownHead`. */
  adoptDetail(key: PrKey, detail: PrDetail, shownHead: string): void;
  /** Every window stops editing `key`'s draft (resolves once announced). */
  lock(key: PrKey): Promise<void>;
  /** Windows re-read `key`'s draft from disk, then edit again. Never throws. */
  unlock(key: PrKey): Promise<void>;
}

export interface SubmitFlowState {
  busy: boolean;
  error: string | null;
}

/** The submit decisions and post-submit merge; resolves to a message, never throws. */
export async function runSubmitWith(
  flow: SubmitFlowState,
  d: SubmitDeps,
  key: PrKey,
  edits: { event: ReviewEvent; body: string },
): Promise<string> {
  if (flow.busy) return "A submit is already running.";
  const v = d.view();
  if (!v.open || v.selectedKey !== key) return NOT_OPEN;
  const { pr, headSha: head } = v;
  if (!pr || !head || !v.detail || !v.hasRecord) return v.error ?? "This PR is still loading.";
  if (v.headMoved) return submitErrorMessage(new Error("submit-blocked:not-seen"));

  flow.busy = true;
  flow.error = null;
  const fail = (msg: string) => {
    flow.error = msg;
    d.toast(msg);
    return msg;
  };
  try {
    let start: PrRecord;
    try {
      // Before the snapshot: no window may change the draft until the merge is saved.
      await d.lock(key);
      // The open-time detail may predate a push (the list refresh can lag): ask GitHub.
      const detail = await d.prDetail(pr.host, pr.nodeId);
      if (detail.headSha !== head) {
        d.adoptDetail(key, detail, head);
        return fail(HEAD_MOVED);
      }
      // The stored record, not the in-memory one: the other window may have saved since.
      start = { ...(await d.loadRecord(key)), event: edits.event, body: edits.body };
      const block = submitBlock(start, head);
      if (block) throw new Error(`submit-blocked:${block}`);
      const choices = pendingChoices(detail.pendingReviewId, detail.pendingReviewCommit, head);
      const choice = choices ? await d.askPending(choices) : null;
      if (choices && !choice) return "Submit cancelled.";
      const now = d.view();
      if (!now.open || now.selectedKey !== key || now.headSha !== head || now.headMoved) {
        return "The PR changed; nothing was submitted.";
      }
      await d.submit({
        host: pr.host,
        prNodeId: pr.nodeId,
        headSha: head,
        record: start,
        existingPendingId: detail.pendingReviewId,
        existingPendingCommit: detail.pendingReviewCommit,
        choice,
      });
    } catch (e) {
      return fail(submitErrorMessage(e)); // the draft is untouched
    }

    // Edits made in either window during the submit stay: drop only what was sent.
    const sent = submittable(start).map((i) => i.id);
    d.toast("Review submitted");
    d.reloadDetail();
    try {
      const next = removeSubmitted(await d.loadRecord(key), sent);
      await d.saveRecord(next);
      d.adopt(key, next);
    } catch (e) {
      flow.error =
        `Review submitted, but the draft could not be updated (${e}). ` +
        "Remove the submitted comments before submitting again.";
      return flow.error;
    }
    return "Review submitted";
  } finally {
    await d.unlock(key);
    flow.busy = false;
  }
}
