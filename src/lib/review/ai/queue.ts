import type { PrKey } from "../types";

export type JobKind = "review" | "rereview";
export interface QueueEntry { key: PrKey; kind: JobKind }

/** AI jobs run one at a time: `running` holds the slot, `waiting` is FIFO. */
export type Queue = { running: QueueEntry | null; waiting: QueueEntry[] };

export const emptyQueue = (): Queue => ({ running: null, waiting: [] });

const same = (a: QueueEntry | null, b: QueueEntry): boolean => a !== null && a.key === b.key && a.kind === b.kind;

export function enqueue(q: Queue, e: QueueEntry): Queue {
  if (same(q.running, e) || q.waiting.some((w) => same(w, e))) return q;
  return { ...q, waiting: [...q.waiting, e] };
}

/** A running entry stays in the slot (the caller kills it, then calls `finish`). */
export function cancel(q: Queue, e: QueueEntry): { q: Queue; killRunning: boolean } {
  if (same(q.running, e)) return { q, killRunning: true };
  if (!q.waiting.some((w) => same(w, e))) return { q, killRunning: false };
  return { q: { ...q, waiting: q.waiting.filter((w) => !same(w, e)) }, killRunning: false };
}

/** Frees the slot (if held) and moves the first waiting entry into it. */
export function finish(q: Queue): { q: Queue; next: QueueEntry | null } {
  const [next = null, ...rest] = q.waiting;
  return { q: { running: next, waiting: rest }, next };
}
