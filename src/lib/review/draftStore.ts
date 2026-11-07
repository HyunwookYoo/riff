import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { parseRecord } from "./draft";
import { loadReview, saveReview } from "./gh";
import type { PrKey, PrRecord } from "./types";

const CHANGED_EVENT = "review-draft-changed";
export const REVEAL_EVENT = "review-reveal";
export interface RevealPayload { key: PrKey; itemId: string }

export async function loadRecord(key: PrKey): Promise<PrRecord> {
  return parseRecord(await loadReview(key), key);
}

export async function saveRecord(r: PrRecord): Promise<void> {
  await saveReview(r.key, r);
  await emit(CHANGED_EVENT, { key: r.key, origin: getCurrentWebviewWindow().label });
}

export function onRecordChanged(key: PrKey, cb: (r: PrRecord) => void): Promise<() => void> {
  const own = getCurrentWebviewWindow().label;
  return listen<{ key: PrKey; origin: string }>(CHANGED_EVENT, async (e) => {
    if (e.payload.key !== key || e.payload.origin === own) return;
    cb(await loadRecord(key));
  });
}
