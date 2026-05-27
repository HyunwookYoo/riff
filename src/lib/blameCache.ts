import type { Blame } from "./types";

/**
 * Tiny LRU cache for blame results keyed by (repoIdx, path). Lives at module
 * scope so the BlameView component's unmount/remount cycle (e.g. drill-in
 * round-trip) doesn't drop the loaded data. Cleared on main-repo switch.
 */
interface Entry {
  fileText: string;
  blame: Blame;
}

const CAPACITY = 10;
const cache = new Map<string, Entry>();

function makeKey(repoIdx: number, path: string): string {
  return `${repoIdx}:${path}`;
}

export function getBlameCache(repoIdx: number, path: string): Entry | null {
  const k = makeKey(repoIdx, path);
  const v = cache.get(k);
  if (!v) return null;
  // LRU bump: re-insert moves the key to the end of the iteration order.
  cache.delete(k);
  cache.set(k, v);
  return v;
}

export function setBlameCache(
  repoIdx: number,
  path: string,
  entry: Entry,
): void {
  const k = makeKey(repoIdx, path);
  if (cache.has(k)) cache.delete(k);
  cache.set(k, entry);
  while (cache.size > CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearBlameCache(): void {
  cache.clear();
}
