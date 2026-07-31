import { describe, it, expect } from "vitest";
import { applyClick, defaultStashMessage } from "./changesSelect";

// Four files rendered in one changelist, in this on-screen order.
const ORDER = ["a.ts", "b.ts", "c.ts", "d.ts"];
// Ordinary single-selection mode: nothing multi-selected, no anchor yet.
const empty = { selected: new Set<string>(), anchor: null };

describe("applyClick", () => {
  it("a plain click drops back to single selection", () => {
    const r = applyClick(
      "plain",
      { selected: new Set(["a.ts", "b.ts"]), anchor: "a.ts" },
      "b.ts",
      "c.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual([]);
    expect(r.anchor).toBe("c.ts");
  });

  it("the first Ctrl+click seeds the set from the single selection", () => {
    const r = applyClick("toggle", empty, "a.ts", "c.ts", ORDER);
    expect([...r.selected].sort()).toEqual(["a.ts", "c.ts"]);
    expect(r.anchor).toBe("c.ts");
  });

  it("Ctrl+click with no single selection starts from the clicked file", () => {
    const r = applyClick("toggle", empty, null, "b.ts", ORDER);
    expect([...r.selected]).toEqual(["b.ts"]);
  });

  it("Ctrl+click removes an already-selected file", () => {
    const r = applyClick(
      "toggle",
      { selected: new Set(["a.ts", "b.ts"]), anchor: "b.ts" },
      "b.ts",
      "a.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual(["b.ts"]);
  });

  it("Ctrl+click on the only selected file empties the set", () => {
    const r = applyClick("toggle", empty, "a.ts", "a.ts", ORDER);
    expect(r.selected.size).toBe(0);
  });

  it("Shift+click fills the range forward, inclusive", () => {
    const r = applyClick(
      "range",
      { selected: new Set(["a.ts"]), anchor: "a.ts" },
      "a.ts",
      "c.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(r.anchor).toBe("a.ts");
  });

  it("Shift+click fills the range backward too", () => {
    const r = applyClick(
      "range",
      { selected: new Set(["d.ts"]), anchor: "d.ts" },
      "d.ts",
      "b.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(r.anchor).toBe("d.ts");
  });

  it("Shift+click with no anchor pivots on the single selection", () => {
    const r = applyClick("range", empty, "b.ts", "d.ts", ORDER);
    expect([...r.selected]).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(r.anchor).toBe("b.ts");
  });

  it("Shift+click with neither anchor nor single selection takes one file", () => {
    const r = applyClick("range", empty, null, "c.ts", ORDER);
    expect([...r.selected]).toEqual(["c.ts"]);
    expect(r.anchor).toBe("c.ts");
  });

  it("falls back to one file when the anchor is no longer on screen", () => {
    // "gone.ts" was the anchor before its changelist got collapsed.
    const r = applyClick(
      "range",
      { selected: new Set(["gone.ts"]), anchor: "gone.ts" },
      "gone.ts",
      "c.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual(["c.ts"]);
    expect(r.anchor).toBe("c.ts");
  });

  it("a range only spans rows that are on screen", () => {
    // Conflicted and collapsed rows never enter `order`, so a range cannot
    // select them even when they sit between the two ends visually.
    const r = applyClick(
      "range",
      { selected: new Set<string>(), anchor: "a.ts" },
      "a.ts",
      "d.ts",
      ["a.ts", "d.ts"],
    );
    expect([...r.selected]).toEqual(["a.ts", "d.ts"]);
  });
});

describe("defaultStashMessage", () => {
  it("uses the path itself for one file", () => {
    expect(defaultStashMessage(["src/lib/git.ts"])).toBe("src/lib/git.ts");
  });

  it("summarises several files by basename", () => {
    expect(defaultStashMessage(["src/lib/git.ts", "src/lib/store.ts"])).toBe(
      "2 files: git.ts, store.ts",
    );
  });

  it("caps the name list at three", () => {
    expect(
      defaultStashMessage(["a/1.ts", "a/2.ts", "a/3.ts", "a/4.ts", "a/5.ts"]),
    ).toBe("5 files: 1.ts, 2.ts, 3.ts, +2 more");
  });
});
