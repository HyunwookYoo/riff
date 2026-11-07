import { describe, expect, it } from "vitest";
import { groupByLine, type InlineItem } from "./cmReview";

const item = (line: number, key: string): InlineItem => ({ line, key, mount: () => () => {} });

describe("groupByLine", () => {
  it("groupByLine keeps insertion order per line", () => {
    const items = [item(5, "a"), item(2, "b"), item(5, "c"), item(2, "d"), item(9, "e")];
    const g = groupByLine(items);
    expect([...g.keys()].sort((x, y) => x - y)).toEqual([2, 5, 9]);
    expect(g.get(5)!.map((i) => i.key)).toEqual(["a", "c"]);
    expect(g.get(2)!.map((i) => i.key)).toEqual(["b", "d"]);
    expect(g.get(9)!.map((i) => i.key)).toEqual(["e"]);
  });

  it("returns an empty map for no items", () => {
    expect(groupByLine([]).size).toBe(0);
  });
});
