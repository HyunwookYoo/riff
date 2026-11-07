import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emptyRecord, isValidRecord } from "./draft";
import { loadReview, saveReview } from "./gh";
import type { PrKey, PrRecord, ReviewEvent } from "./types";

const CHANGED_EVENT = "review-draft-changed";
export const REVEAL_EVENT = "review-reveal";
export interface RevealPayload { key: PrKey; itemId: string }
/** Drafts window → main window: the main window owns submit. */
export const SUBMIT_REQUEST_EVENT = "review-submit-request";
export interface SubmitRequest { key: PrKey; event: ReviewEvent; body: string }
/** Main window → drafts window: the outcome of a SUBMIT_REQUEST_EVENT. */
export const SUBMIT_REPLY_EVENT = "review-submit-reply";
export interface SubmitReply { key: PrKey; message: string }
/** Main window → drafts window: show another PR's draft. */
export const DRAFTS_OPEN_EVENT = "review-drafts-open";
export const DRAFTS_LABEL = "review-drafts";

export function draftsWindowUrl(key: PrKey): string {
  return `/?view=drafts&key=${encodeURIComponent(key)}`;
}

export function parseDraftsUrl(search: string): PrKey | null {
  const q = new URLSearchParams(search);
  return q.get("view") === "drafts" ? q.get("key") || null : null;
}

/** An open drafts window is pointed at `key` in place (DRAFTS_OPEN_EVENT), not reloaded. */
export async function openDraftsWindow(key: PrKey): Promise<void> {
  const existing = await WebviewWindow.getByLabel(DRAFTS_LABEL);
  if (existing) {
    await emitTo(DRAFTS_LABEL, DRAFTS_OPEN_EVENT, { key });
    await existing.setFocus();
    return;
  }
  const w = new WebviewWindow(DRAFTS_LABEL, {
    url: draftsWindowUrl(key),
    title: "riff · Review draft",
    width: 640,
    height: 760,
    decorations: true,
  });
  await new Promise<void>((resolve, reject) => {
    void w.once("tauri://created", () => resolve());
    void w.once<unknown>("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
}

export async function loadRecord(key: PrKey): Promise<PrRecord> {
  const stored = await loadReview(key);
  if (stored === null || stored === undefined) return emptyRecord(key);
  if (!isValidRecord(stored)) throw new Error("unreadable-review-record");
  return { ...stored, key };
}

export async function saveRecord(r: PrRecord): Promise<void> {
  await saveReview(r.key, r);
  await emit(CHANGED_EVENT, { key: r.key, origin: getCurrentWebviewWindow().label });
}

/** `onError` gets load failures, e.g. Error("unreadable-review-record"). */
export function onRecordChanged(
  key: PrKey,
  cb: (r: PrRecord) => void,
  onError?: (e: unknown) => void,
): Promise<() => void> {
  const own = getCurrentWebviewWindow().label;
  return listen<{ key: PrKey; origin: string }>(CHANGED_EVENT, async (e) => {
    if (e.payload.key !== key || e.payload.origin === own) return;
    let r: PrRecord;
    try {
      r = await loadRecord(key);
    } catch (err) {
      onError?.(err);
      return;
    }
    cb(r);
  });
}
