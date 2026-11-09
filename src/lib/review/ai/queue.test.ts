import { describe, expect, it } from "vitest";
import { cancel, emptyQueue, enqueue, finish, type QueueEntry } from "./queue";

const r = (key: string): QueueEntry => ({ key, kind: "review" });
const rr = (key: string): QueueEntry => ({ key, kind: "rereview" });

describe("queue", () => {
  it("enqueue twice is a no-op", () => {
    const q1 = enqueue(emptyQueue(), r("a"));
    expect(enqueue(q1, r("a"))).toBe(q1);
    const { q: q2 } = finish(q1); // a runs
    expect(q2.running).toEqual(r("a"));
    expect(enqueue(q2, r("a"))).toBe(q2);
    expect(enqueue(q2, r("b"))).toEqual({ running: r("a"), waiting: [r("b")] });
  });

  it("same key review and rereview can both queue", () => {
    const q1 = enqueue(emptyQueue(), r("a"));
    const q2 = enqueue(q1, rr("a"));
    expect(q2).toEqual({ running: null, waiting: [r("a"), rr("a")] });
    expect(enqueue(q2, rr("a"))).toBe(q2);
    const { q: q3, next } = finish(q2);
    expect(next).toEqual(r("a"));
    expect(enqueue(q3, rr("a"))).toBe(q3);
    expect(cancel(q3, rr("a"))).toEqual({ q: { running: r("a"), waiting: [] }, killRunning: false });
    expect(cancel(q3, r("a")).killRunning).toBe(true);
  });

  it("cancel waiting removes it", () => {
    const q = { running: r("a"), waiting: [r("b"), r("c")] };
    expect(cancel(q, r("b"))).toEqual({ q: { running: r("a"), waiting: [r("c")] }, killRunning: false });
    expect(cancel(q, r("zzz"))).toEqual({ q, killRunning: false });
    expect(cancel(q, rr("b"))).toEqual({ q, killRunning: false });
  });

  it("cancel running kills and finish starts next", () => {
    const q = { running: r("a"), waiting: [r("b"), r("c")] };
    const c = cancel(q, r("a"));
    expect(c.killRunning).toBe(true);
    expect(finish(c.q)).toEqual({ q: { running: r("b"), waiting: [r("c")] }, next: r("b") });
    expect(finish({ running: r("c"), waiting: [] })).toEqual({ q: emptyQueue(), next: null });
  });
});
