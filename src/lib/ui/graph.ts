import type { Commit } from "$lib/types";

/// One drawable segment inside a commit row's graph cell. Coordinates are in
/// abstract units: `x` is a lane column index, `y` is 0 (top edge) / 0.5 (row
/// center, where the node sits) / 1 (bottom edge). The renderer scales x by the
/// lane width and y by the row height. `color` indexes a palette (lane hue).
export interface GraphSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
}

export interface GraphRow {
  /// Column the commit's node circle sits in.
  col: number;
  /// Palette index for the node (matches its lane color).
  color: number;
  /// Line segments wiring this row's top edge → node → bottom edge.
  segments: GraphSegment[];
  /// Lanes active in/around this row — drives the per-row graph width.
  laneCount: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  /// Max lane count across all rows — the graph gutter's column count.
  maxLanes: number;
}

const colorFor = (col: number): number => col;

/// Insert parent `p` into the lane array, returning its column. Prefers
/// `preferred` when it's free, then the leftmost free slot, then a new
/// rightmost lane. We intentionally do *not* fold `p` into an existing lane
/// that already waits for the same sha — letting two lanes run in parallel and
/// converge at the parent's own row gives the conventional railroad look
/// (side-by-side verticals joining at the merge point) instead of an early
/// diagonal collapse.
function placeParent(
  lanes: (string | null)[],
  p: string,
  preferred?: number,
): number {
  if (
    preferred !== undefined &&
    (preferred >= lanes.length || lanes[preferred] == null)
  ) {
    lanes[preferred] = p;
    return preferred;
  }
  const free = lanes.indexOf(null);
  if (free !== -1) {
    lanes[free] = p;
    return free;
  }
  lanes.push(p);
  return lanes.length - 1;
}

/// Compute commit-graph lane positions for an ordered (newest-first) commit
/// list. A lane is a column tracking which commit it next expects to reach;
/// when a commit arrives it claims the (leftmost) lane(s) waiting for it, then
/// hands its lane to its first parent and opens new lanes for merge parents.
/// The same sha may sit in several lanes at once (two branches both heading for
/// the same commit); they all converge when that commit's row is reached.
export function computeGraph(commits: Commit[]): GraphLayout {
  let lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let maxLanes = 0;

  for (const c of commits) {
    const before = lanes.slice();

    // Lanes already waiting for this commit converge at its node; the leftmost
    // becomes the node column. With none, this is a branch tip → fresh lane.
    const hits: number[] = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] === c.sha) hits.push(i);
    }

    const after = before.slice();
    let col: number;
    if (hits.length > 0) {
      col = hits[0];
      for (const h of hits) after[h] = null;
    } else {
      const free = after.indexOf(null);
      col = free !== -1 ? free : after.length;
    }

    // Hand the lane(s) to parents: first parent continues the node's column,
    // additional (merge) parents open lanes to the right.
    const parentCols: number[] = [];
    if (c.parents.length > 0) {
      parentCols.push(placeParent(after, c.parents[0], col));
      for (let k = 1; k < c.parents.length; k++) {
        parentCols.push(placeParent(after, c.parents[k]));
      }
    } else if (col < after.length) {
      // Root commit: its lane ends here.
      after[col] = null;
    }

    while (after.length > 0 && after[after.length - 1] == null) after.pop();

    // Wire the cell: incoming lanes (top) → node/pass-through → outgoing (bottom).
    const segments: GraphSegment[] = [];
    for (let j = 0; j < before.length; j++) {
      const s = before[j];
      if (s == null) continue;
      if (s === c.sha) {
        // This lane reaches the node — diagonal up into the node center.
        segments.push({ x1: j, y1: 0, x2: col, y2: 0.5, color: colorFor(j) });
      } else {
        // Pass-through lanes stay in their column (we never shift them), so
        // they draw as a straight vertical across the cell.
        segments.push({ x1: j, y1: 0, x2: j, y2: 1, color: colorFor(j) });
      }
    }
    for (const m of parentCols) {
      segments.push({ x1: col, y1: 0.5, x2: m, y2: 1, color: colorFor(m) });
    }

    const laneCount = Math.max(before.length, after.length, col + 1);
    if (laneCount > maxLanes) maxLanes = laneCount;
    rows.push({ col, color: colorFor(col), segments, laneCount });
    lanes = after;
  }

  return { rows, maxLanes };
}
