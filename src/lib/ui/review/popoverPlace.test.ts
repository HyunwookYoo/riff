import { describe, expect, it } from "vitest";
import { popoverPlace } from "./popoverPlace";

const view = { width: 1000, height: 800 };

describe("popoverPlace", () => {
  it("opens below the anchor, left-aligned", () => {
    expect(popoverPlace({ left: 100, top: 200, bottom: 220 }, { width: 260, height: 150 }, view)).toEqual({ x: 100, y: 224 });
  });
  it("flips above when its measured height would run off the bottom", () => {
    // 150 tall fits below 600; 200 tall (custom field shown) does not.
    expect(popoverPlace({ left: 100, top: 580, bottom: 600 }, { width: 260, height: 150 }, view).y).toBe(604);
    expect(popoverPlace({ left: 100, top: 580, bottom: 600 }, { width: 260, height: 200 }, view).y).toBe(376);
  });
  it("stays inside the viewport", () => {
    expect(popoverPlace({ left: 900, top: 200, bottom: 220 }, { width: 260, height: 150 }, view).x).toBe(736);
    expect(popoverPlace({ left: -20, top: 200, bottom: 220 }, { width: 260, height: 150 }, view).x).toBe(4);
    expect(popoverPlace({ left: 100, top: 60, bottom: 780 }, { width: 260, height: 150 }, view).y).toBe(4);
  });
});
