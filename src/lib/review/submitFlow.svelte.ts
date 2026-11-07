import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { appState } from "../store.svelte";
import { showToast } from "../ui/toast";
import {
  DRAFTS_LABEL,
  loadRecord,
  saveRecord,
  SUBMIT_BUSY_EVENT,
  SUBMIT_REPLY_EVENT,
  SUBMIT_REQUEST_EVENT,
  type SubmitBusy,
  type SubmitReply,
  type SubmitRequest,
} from "./draftStore";
import { reloadDetail, reviewState, UNREADABLE } from "./reviewState.svelte";
import { submit, type PendingChoice } from "./submit";
import { prDetail } from "./github";
import { runSubmitWith, type SubmitDeps } from "./submitRun";
import type { PrKey, ReviewEvent } from "./types";

class SubmitFlow {
  busy = $state(false);
  error = $state<string | null>(null);
  /** An open PendingReviewDialog; "add" is absent when the web review is pinned elsewhere. */
  dialog = $state<{ choices: PendingChoice[] } | null>(null);
  /** The PR whose draft is being submitted: read-only until the submit ends. */
  lockedKey = $state<PrKey | null>(null);
}

export const submitFlow = new SubmitFlow();

/** The open PR's draft is being submitted: inline widgets must not change it. */
export function draftLocked(): boolean {
  return submitFlow.lockedKey !== null && submitFlow.lockedKey === reviewState.selectedKey;
}

let answer: ((c: PendingChoice | null) => void) | null = null;

/** The PendingReviewDialog's answer; null = Cancel. */
export function answerPending(c: PendingChoice | null): void {
  const a = answer;
  answer = null;
  submitFlow.dialog = null;
  a?.(c);
}

const deps: SubmitDeps = {
  view: () => {
    const s = reviewState;
    const summary = s.prs.find((p) => p.key === s.selectedKey);
    return {
      open: appState.appMode === "review",
      selectedKey: s.selectedKey,
      pr: summary ? { host: summary.repo.host, nodeId: summary.nodeId } : null,
      headSha: s.headSha,
      detail: s.detail,
      hasRecord: !!s.record,
      headMoved: !!s.headMoved,
      error: s.error,
    };
  },
  loadRecord,
  saveRecord,
  submit,
  askPending: (choices) => {
    submitFlow.dialog = { choices };
    // A request from the drafts window: the dialog is here.
    void getCurrentWebviewWindow().setFocus().catch(() => {});
    return new Promise((resolve) => (answer = resolve));
  },
  adopt: (key, r) => {
    if (reviewState.selectedKey === key && reviewState.record) reviewState.record = r;
  },
  reloadDetail: () => void reloadDetail().catch(() => {}),
  toast: showToast,
  prDetail,
  adoptDetail: (key, detail, shownHead) => {
    const s = reviewState;
    if (s.selectedKey !== key || s.headSha !== shownHead) return;
    s.detail = detail;
    if (detail.headSha !== shownHead && s.headMoved?.to !== detail.headSha) {
      s.headMoved = { from: shownHead, to: detail.headSha };
    }
  },
  lock: async (key) => {
    submitFlow.lockedKey = key;
    const p: SubmitBusy = { key, busy: true };
    await emit(SUBMIT_BUSY_EVENT, p);
  },
  unlock: async (key) => {
    // Edits were blocked, so disk holds the newest draft (the merged one after a submit).
    if (reviewState.selectedKey === key && reviewState.record) {
      try {
        const r = await loadRecord(key);
        if (reviewState.selectedKey === key && reviewState.record) reviewState.record = r;
      } catch {
        if (reviewState.selectedKey === key) {
          reviewState.record = null;
          reviewState.error = UNREADABLE;
        }
      }
    }
    submitFlow.lockedKey = null;
    const p: SubmitBusy = { key, busy: false };
    await emit(SUBMIT_BUSY_EVENT, p).catch(() => {});
  },
};

/**
 * The only submit path (main window; the drafts window asks through
 * SUBMIT_REQUEST_EVENT). Needs the PR open in review mode here: it pins to the
 * displayed head. Resolves to a message for the requester; never throws.
 */
export function runSubmit(key: PrKey, edits: { event: ReviewEvent; body: string }): Promise<string> {
  return runSubmitWith(submitFlow, deps, key, edits);
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
