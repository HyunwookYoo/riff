import { describe, it, expect, vi } from "vitest";
import { toCMChanges } from "./changes";
import type { DiffChange } from "../types";

// Stand-in for `new Change(fromA,toA,fromB,toB)` — the real class is injected in
// the app, so tests don't need the editor bundle.
const make = (fromA: number, toA: number, fromB: number, toB: number) => ({
  fromA,
  toA,
  fromB,
  toB,
});

describe("toCMChanges", () => {
  it("maps snake_case offsets through the injected constructor", () => {
    const input: DiffChange[] = [{ from_a: 4, to_a: 4, from_b: 4, to_b: 6 }];
    expect(toCMChanges(input, make)).toEqual([{ fromA: 4, toA: 4, fromB: 4, toB: 6 }]);
  });

  it("invokes make once per change, in order, with positional offsets", () => {
    const spy = vi.fn(make);
    toCMChanges(
      [
        { from_a: 0, to_a: 2, from_b: 0, to_b: 0 },
        { from_a: 10, to_a: 10, from_b: 8, to_b: 12 },
      ],
      spy,
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]).toEqual([0, 2, 0, 0]);
    expect(spy.mock.calls[1]).toEqual([10, 10, 8, 12]);
  });

  it("returns empty for no changes (CRLF-only / identical files)", () => {
    expect(toCMChanges([], make)).toEqual([]);
  });
});
