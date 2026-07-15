import { describe, it, expect } from "vitest";
import { SHORTCUTS } from "./shortcuts";

describe("SHORTCUTS", () => {
  it("has non-empty groups, each with a title and well-formed items", () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
    for (const g of SHORTCUTS) {
      expect(g.title.trim().length).toBeGreaterThan(0);
      expect(g.items.length).toBeGreaterThan(0);
      for (const s of g.items) {
        expect(s.keys.trim().length).toBeGreaterThan(0);
        expect(s.desc.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("documents the palette and shortcuts-overlay triggers", () => {
    const all = SHORTCUTS.flatMap((g) => g.items);
    expect(all.some((s) => s.keys.includes("Ctrl+Shift+P"))).toBe(true);
    expect(all.some((s) => s.keys === "?")).toBe(true);
  });
});
