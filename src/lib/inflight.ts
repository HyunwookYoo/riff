/// Share one in-flight call between everything that asks for the same thing.
///
/// riff's views are torn down and rebuilt on every mode switch, and its
/// refreshes fan out from several places at once (the watcher, the refs
/// sidebar, the branch chip, the diff pane). Each of those already guards
/// against *stale results* with a session counter — but a guard that discards
/// a result does nothing about the work: the git process it started still runs
/// to the end. Clicking between Working Copy and Blame a few times on a large
/// repo is enough to leave several full-tree walks and asset renders running
/// at once, which is what saturates the disk.
///
/// Sharing the promise fixes that at the source: the second caller waits on the
/// first call instead of starting another one.
///
/// Freshness comes from `epoch`. Every write riff makes, and every change the
/// filesystem watcher reports, bumps it — so a read issued after something
/// changed can never join a call that started before it. Within one epoch the
/// repo is unchanged by definition, which is exactly when sharing is safe.
let epoch = 0;

/// Invalidate everything in flight: later callers start their own call.
export function bumpEpoch(): void {
  epoch++;
}

const inflight = new Map<string, Promise<unknown>>();

export function share<T>(key: string, run: () => Promise<T>): Promise<T> {
  const k = `${epoch}|${key}`;
  const existing = inflight.get(k) as Promise<T> | undefined;
  if (existing) return existing;
  const p = run();
  inflight.set(k, p);
  // Drop the entry once it settles, whichever way. The `catch` is on the
  // derived promise only — it keeps a rejection from surfacing as unhandled
  // here; `p` itself still rejects for every real caller.
  void p
    .finally(() => {
      if (inflight.get(k) === p) inflight.delete(k);
    })
    .catch(() => {});
  return p;
}

/// Test seam: how many calls are currently shared.
export function inflightCount(): number {
  return inflight.size;
}
