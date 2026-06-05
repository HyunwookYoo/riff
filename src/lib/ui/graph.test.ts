import { describe, it, expect } from "vitest";
import { computeGraph } from "./graph";
import type { Commit } from "$lib/types";

// Minimal commit factory — only sha + parents matter to the layout.
function c(sha: string, parents: string[] = []): Commit {
  return {
    sha,
    short_sha: sha,
    parents,
    author: "",
    time: 0,
    summary: "",
    refs: [],
  };
}

describe("computeGraph", () => {
  it("lays a linear history in a single lane", () => {
    // A → B → C (newest first), each parent the next row.
    const { rows, maxLanes } = computeGraph([
      c("A", ["B"]),
      c("B", ["C"]),
      c("C", []),
    ]);
    expect(maxLanes).toBe(1);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    // Root commit has no outgoing parent edge.
    expect(rows[2].segments.some((s) => s.y2 === 1)).toBe(false);
  });

  it("opens a new lane for a merge's second parent", () => {
    //   A (merge of B, C)
    //   B
    //   C
    // A is on lane 0; the second parent C must get its own lane.
    const { rows, maxLanes } = computeGraph([
      c("A", ["B", "C"]),
      c("B", ["C"]),
      c("C", []),
    ]);
    expect(maxLanes).toBe(2);
    expect(rows[0].col).toBe(0);
    // The merge row emits two downward edges (to B and C lanes).
    const down = rows[0].segments.filter((s) => s.y1 === 0.5 && s.y2 === 1);
    expect(down.length).toBe(2);
    expect(down.map((s) => s.x2).sort()).toEqual([0, 1]);
  });

  it("converges a side branch back into the trunk", () => {
    //   A          lane0: A -> B
    //   B          lane0: B -> D ; merge row? no — B has one parent D
    //   X          lane1 tip (X -> D), no incoming
    //   D          both lane0 (B) and lane1 (X) expect D -> converge at col 0
    const { rows } = computeGraph([
      c("A", ["B"]),
      c("B", ["D"]),
      c("X", ["D"]),
      c("D", []),
    ]);
    // X is a branch tip → its own lane (col 1).
    expect(rows[2].col).toBe(1);
    // D is reached by two lanes; node lands on the leftmost (col 0), and the
    // right lane (col 1) draws an incoming edge into the node.
    expect(rows[3].col).toBe(0);
    const intoNode = rows[3].segments.filter(
      (s) => s.y1 === 0 && s.y2 === 0.5,
    );
    expect(intoNode.map((s) => s.x1).sort()).toEqual([0, 1]);
  });

  it("handles an empty list", () => {
    expect(computeGraph([])).toEqual({ rows: [], maxLanes: 0 });
  });
});
