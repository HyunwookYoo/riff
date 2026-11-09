import type { PrKey } from "../types";

/** AI jobs run one at a time: `running` holds the slot, `waiting` is FIFO. */
export type Queue = { running: PrKey | null; waiting: PrKey[] };

export const emptyQueue = (): Queue => ({ running: null, waiting: [] });

export function enqueue(q: Queue, key: PrKey): Queue {
  if (q.running === key || q.waiting.includes(key)) return q;
  return { ...q, waiting: [...q.waiting, key] };
}

/** A running key stays in the slot (the caller kills it, then calls `finish`). */
export function cancel(q: Queue, key: PrKey): { q: Queue; killRunning: boolean } {
  if (q.running === key) return { q, killRunning: true };
  if (!q.waiting.includes(key)) return { q, killRunning: false };
  return { q: { ...q, waiting: q.waiting.filter((k) => k !== key) }, killRunning: false };
}

/** Frees the slot (if held) and moves the first waiting key into it. */
export function finish(q: Queue): { q: Queue; next: PrKey | null } {
  const [next = null, ...rest] = q.waiting;
  return { q: { running: next, waiting: rest }, next };
}
