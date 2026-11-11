import { describe, it, expect } from "vitest";
import { fileFindingBadges, findingIndex } from "./findingIndex";
import type { ShownFinding } from "./result";

function f(id: string, path: string, line: number, severity: "high" | "medium" | "low", body = "body"): ShownFinding {
  return {
    id, path, line, startLine: null, side: "RIGHT", severity, body,
    evidence: [], status: "confirmed", quote: [],
    target: { kind: "line", path, side: "RIGHT", line, startLine: null, quote: [] },
  };
}

describe("findingIndex", () => {
  it("lists inline and off-diff findings, high first, then by path and line", () => {
    const rows = findingIndex(
      [f("a", "src/b.ts", 9, "low"), f("b", "src/a.ts", 30, "high"), f("c", "src/a.ts", 4, "high")],
      [f("d", "src/c.ts", 2, "medium")],
    );
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "d", "a"]);
    expect(rows[2].offDiff).toBe(true);
    expect(rows[0].offDiff).toBe(false);
  });

  it("summary is the first non-empty line of the body, trimmed", () => {
    const [r] = findingIndex([f("a", "x.ts", 1, "low", "\n  Null check missing here.\nMore text")], []);
    expect(r.summary).toBe("Null check missing here.");
  });

  it("carries the Roblox tag", () => {
    const rows = findingIndex([{ ...f("a", "x.ts", 1, "low"), tag: "roblox" }], [f("b", "y.ts", 1, "low")]);
    expect(rows.map((r) => r.tag)).toEqual(["roblox", undefined]);
  });
});

describe("fileFindingBadges", () => {
  it("counts per path and keeps the highest severity", () => {
    const m = fileFindingBadges([f("a", "x.ts", 1, "low"), f("b", "x.ts", 2, "high"), f("c", "y.ts", 3, "medium")]);
    expect(m.get("x.ts")).toEqual({ count: 2, severity: "high" });
    expect(m.get("y.ts")).toEqual({ count: 1, severity: "medium" });
    expect(m.get("z.ts")).toBeUndefined();
  });
});
