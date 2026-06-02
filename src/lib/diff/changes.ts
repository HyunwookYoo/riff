import type { DiffChange } from "../types";

/**
 * Map backend `DiffChange` records (snake_case UTF-16 offsets) onto
 * `@codemirror/merge` `Change` instances for injection via the editor's
 * `diffConfig.override`, so the editor renders our diff instead of recomputing
 * one (whose default `scanLimit` bails on large, densely-changed files).
 *
 * `make` builds each instance (`(fromA,toA,fromB,toB) => new Change(...)`); it's
 * injected rather than imported so this module — and its tests — stay free of
 * the editor bundle. Real `Change` instances are required, not plain objects:
 * the merge addon's `toChunks` calls `change.offset(...)`, a method.
 */
export function toCMChanges<T>(
  changes: DiffChange[],
  make: (fromA: number, toA: number, fromB: number, toB: number) => T,
): T[] {
  return changes.map((c) => make(c.from_a, c.to_a, c.from_b, c.to_b));
}
