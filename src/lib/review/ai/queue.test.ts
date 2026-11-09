import { describe, expect, it } from "vitest";
import { cancel, emptyQueue, enqueue, finish } from "./queue";

describe("queue", () => {
  it("enqueue twice is a no-op", () => {
    const q1 = enqueue(emptyQueue(), "a");
    expect(enqueue(q1, "a")).toBe(q1);
    const { q: q2 } = finish(q1); // a runs
    expect(q2.running).toBe("a");
    expect(enqueue(q2, "a")).toBe(q2);
    expect(enqueue(q2, "b")).toEqual({ running: "a", waiting: ["b"] });
  });

  it("cancel waiting removes it", () => {
    const q = { running: "a", waiting: ["b", "c"] };
    expect(cancel(q, "b")).toEqual({ q: { running: "a", waiting: ["c"] }, killRunning: false });
    expect(cancel(q, "zzz")).toEqual({ q, killRunning: false });
  });

  it("cancel running kills and finish starts next", () => {
    const q = { running: "a", waiting: ["b", "c"] };
    const c = cancel(q, "a");
    expect(c.killRunning).toBe(true);
    expect(finish(c.q)).toEqual({ q: { running: "b", waiting: ["c"] }, next: "b" });
    expect(finish({ running: "c", waiting: [] })).toEqual({ q: emptyQueue(), next: null });
  });
});
