import { describe, it, expect } from "vitest";
import { bumpEpoch, inflightCount, share } from "./inflight";

/// A promise plus the handles to settle it, so a test can hold a call open.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("share", () => {
  it("runs one call for concurrent callers of the same key", async () => {
    const d = deferred<string>();
    let runs = 0;
    const run = () => {
      runs++;
      return d.promise;
    };
    const a = share("k", run);
    const b = share("k", run);
    expect(runs).toBe(1);
    d.resolve("value");
    expect(await a).toBe("value");
    expect(await b).toBe("value");
  });

  it("keeps different keys apart", async () => {
    let runs = 0;
    const run = () => {
      runs++;
      return Promise.resolve(runs);
    };
    await Promise.all([share("a", run), share("b", run)]);
    expect(runs).toBe(2);
  });

  it("starts a new call once the previous one has settled", async () => {
    let runs = 0;
    const run = () => {
      runs++;
      return Promise.resolve(runs);
    };
    expect(await share("k", run)).toBe(1);
    expect(await share("k", run)).toBe(2);
  });

  it("does not share across an epoch bump", async () => {
    const d = deferred<number>();
    let runs = 0;
    const first = share("k", () => {
      runs++;
      return d.promise;
    });
    // Something changed the repo — a read issued now must not be answered by
    // the call that started before it.
    bumpEpoch();
    const second = share("k", () => {
      runs++;
      return Promise.resolve(2);
    });
    expect(runs).toBe(2);
    d.resolve(1);
    expect(await first).toBe(1);
    expect(await second).toBe(2);
  });

  it("gives every sharer the same rejection and forgets the call", async () => {
    const d = deferred<never>();
    const a = share("k", () => d.promise);
    const b = share("k", () => d.promise);
    const err = new Error("git said no");
    d.reject(err);
    await expect(a).rejects.toBe(err);
    await expect(b).rejects.toBe(err);
    // Settled calls are dropped, so the next caller retries rather than
    // inheriting the failure forever.
    await Promise.resolve();
    expect(inflightCount()).toBe(0);
  });
});
