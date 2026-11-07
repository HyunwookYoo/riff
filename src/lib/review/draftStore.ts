import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emptyRecord, isValidRecord } from "./draft";
import { loadReview, saveReview } from "./gh";
import type { PrKey, PrRecord } from "./types";

const CHANGED_EVENT = "review-draft-changed";
export const REVEAL_EVENT = "review-reveal";
export interface RevealPayload { key: PrKey; itemId: string }

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
