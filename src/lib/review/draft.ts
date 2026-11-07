import { reanchor } from "./anchor";
import type { DraftItem, DraftOrigin, DraftTarget, FileHunks, PrKey, PrRecord, ReviewEvent } from "./types";

export function emptyRecord(key: PrKey): PrRecord {
  return { version: 1, key, items: [], body: "", event: "COMMENT", anchorHead: null, viewedHead: null };
}

export function addItem(r: PrRecord, target: DraftTarget, body: string, origin: DraftOrigin): PrRecord {
  const item: DraftItem = { id: crypto.randomUUID(), target, body, origin, unplaced: false };
  return { ...r, items: [...r.items, item] };
}

export function editItem(r: PrRecord, id: string, body: string): PrRecord {
  return {
    ...r,
    items: r.items.map((i) =>
      i.id !== id ? i : { ...i, body, origin: i.origin === "ai" ? "ai-edited" : i.origin }),
  };
}

export function removeItem(r: PrRecord, id: string): PrRecord {
  return { ...r, items: r.items.filter((i) => i.id !== id) };
}

export function setBody(r: PrRecord, body: string): PrRecord {
  return { ...r, body };
}

export function setEvent(r: PrRecord, event: ReviewEvent): PrRecord {
  return { ...r, event };
}

/** `texts` is keyed `${path}|${side}` and holds that side's full file text at `newHead`. */
export function reanchorAll(
  r: PrRecord,
  newHead: string,
  texts: Map<string, string>,
  files: FileHunks[],
): PrRecord {
  const items = r.items.map((i): DraftItem => {
    const t = i.target;
    if (t.kind !== "line") return i;
    const text = texts.get(`${t.path}|${t.side}`);
    const placed = text === undefined
      ? null
      : reanchor(t, text, files.find((f) => f.path === t.path));
    if (!placed) return { ...i, unplaced: true };
    return { ...i, unplaced: false, target: { ...t, line: placed.line, startLine: placed.startLine } };
  });
  return { ...r, items, anchorHead: newHead };
}

export function submittable(r: PrRecord): DraftItem[] {
  return r.items.filter((i) => !i.unplaced);
}

export function parseRecord(v: unknown, key: PrKey): PrRecord {
  if (!v || typeof v !== "object" || (v as { version?: unknown }).version !== 1) return emptyRecord(key);
  return { ...emptyRecord(key), ...(v as PrRecord), key };
}
