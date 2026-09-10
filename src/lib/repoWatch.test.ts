import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// repoWatch subscribes through Tauri's event bus and drives workingCopy's
// refresh, so both are stubbed: `listen` hands back the emitted handler, and
// refreshActiveView resolves only when the test says so — that's what makes an
// overlapping pass observable.
const bus = vi.hoisted(() => ({ handlers: [] as Array<() => void> }));
const refresh = vi.hoisted(() => ({
  calls: 0,
  inFlight: 0,
  maxInFlight: 0,
  resolvers: [] as Array<() => void>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_event: string, cb: () => void) => {
    bus.handlers.push(cb);
    return Promise.resolve(() => {});
  },
}));
vi.mock("./store.svelte", () => ({
  appState: { repoPath: "/repo", gitOpDepth: 0 },
}));
vi.mock("./workingCopy", () => ({
  refreshActiveView: () => {
    refresh.calls++;
    refresh.inFlight++;
    refresh.maxInFlight = Math.max(refresh.maxInFlight, refresh.inFlight);
    return new Promise<void>((resolve) => {
      refresh.resolvers.push(() => {
        refresh.inFlight--;
        resolve();
      });
    });
  },
  loadPendingOp: () => Promise.resolve(),
}));

/// Fresh module instance per test — the in-flight guard is module state.
async function subscribe(): Promise<() => void> {
  vi.resetModules();
  bus.handlers.length = 0;
  const { initRepoWatch } = await import("./repoWatch");
  await initRepoWatch();
  return bus.handlers[0];
}

describe("repoWatch", () => {
  beforeEach(() => {
    refresh.calls = 0;
    refresh.inFlight = 0;
    refresh.maxInFlight = 0;
    refresh.resolvers.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("collapses events arriving during a pass into one trailing pass", async () => {
    const fire = await subscribe();

    fire();
    await vi.advanceTimersByTimeAsync(120);
    expect(refresh.calls).toBe(1);

    // Sustained churn: the backend re-emits every 1.5s while a pass on a big
    // repo is still walking the tree. None of these may start a second pass.
    for (let i = 0; i < 10; i++) {
      fire();
      await vi.advanceTimersByTimeAsync(1500);
    }
    expect(refresh.calls).toBe(1);

    // The pass finishes: exactly one catch-up pass, not ten.
    refresh.resolvers.shift()!();
    await vi.advanceTimersByTimeAsync(120);
    expect(refresh.calls).toBe(2);
    expect(refresh.maxInFlight).toBe(1);

    // With nothing new pending, the loop settles instead of re-arming.
    refresh.resolvers.shift()!();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh.calls).toBe(2);
  });

  it("coalesces a burst that lands before the pass starts", async () => {
    const fire = await subscribe();

    fire();
    fire();
    fire();
    await vi.advanceTimersByTimeAsync(120);
    expect(refresh.calls).toBe(1);
  });
});
