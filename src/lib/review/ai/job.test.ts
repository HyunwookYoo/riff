import { describe, expect, it, vi } from "vitest";
import { cancelJob, createRunner, requestJob, runJob, type AiCtx, type JobDeps } from "./job";
import { FIND_SCHEMA, VERIFY_SCHEMA } from "./prompts";
import { emptyQueue } from "./queue";
import type { AiResult } from "./types";
import type { PrDetail, PrSummary } from "../types";

const flush = () => new Promise((r) => setTimeout(r, 0));

const summary = (n: number, o: Partial<PrSummary> = {}): PrSummary => ({
  key: `github.com/o/r#${n}`, repo: { host: "github.com", owner: "o", name: "r" }, repoIdx: 0,
  remote: "origin", nodeId: `N${n}`, number: n, title: `PR ${n}`, author: "me", url: "u",
  additions: 1, deletions: 1, headSha: "oldH", baseSha: "oldB", baseRef: "main", updatedAt: "",
  section: "requested", myLastReviewSha: null, ...o,
});
const detail = (head: string, base: string): PrDetail => ({
  body: "desc", headSha: head, baseSha: base, conversation: [], threads: [],
  pendingReviewId: null, pendingReviewCommit: null,
});

const ev = [{ path: "a.ts", line: 2, quote: "two" }];
const cand = (o: object) => ({ path: "a.ts", side: "RIGHT", line: 2, startLine: null, severity: "high", body: "b", evidence: ev, ...o });

/** Deps for a repo where node `N<n>` has head `H<n>`, base `B<n>`, merge-base `MB<n>`. */
function deps(find: unknown, verify: unknown = { verdicts: [] }) {
  const runs: { schema: object; cancel: ReturnType<typeof vi.fn> }[] = [];
  const d = {
    fetchPr: vi.fn(async (_p: string, _r: string, n: number) => `H${n}`),
    prDetail: vi.fn(async (_h: string, node: string) => detail(`H${node.slice(1)}`, `B${node.slice(1)}`)),
    prHunks: vi.fn(async (_p: string, base: string) => ({
      mergeBase: `MB${base.slice(1)}`,
      files: [{ path: "a.ts", oldPath: null, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 }] }],
    })),
    prDiffText: vi.fn(async () => "diff --git a/a.ts b/a.ts\n"),
    prCommitSubjects: vi.fn(async () => ["subject"]),
    readFileAt: vi.fn(async (_p: string, rev: string, path: string) => {
      if (path !== "a.ts") throw new Error("missing");
      return rev.startsWith("MB") ? "old1\nold2\nold3\n" : "one\ntwo\nthree\n";
    }),
    aiRun: vi.fn((_p: string, _prompt: string, schema: object, _a: (t: string) => void) => {
      const cancel = vi.fn();
      runs.push({ schema, cancel });
      return { done: Promise.resolve(schema === FIND_SCHEMA ? find : verify), cancel };
    }),
    now: () => Date.UTC(2026, 10, 9),
  } satisfies JobDeps;
  return { d, runs };
}

const ctx = (): AiCtx => ({ queue: emptyQueue(), jobs: {}, results: {} });

describe("runJob", () => {
  it("job runs find then verify and returns confirmed+unconfirmed", async () => {
    const find = {
      chapters: [{ title: "T", summary: "s", paths: ["a.ts"] }],
      findings: [cand({}), cand({ side: "LEFT", line: 3, startLine: 2 }), cand({ line: 1 })],
    };
    const verify = { verdicts: [
      { index: 0, verdict: "confirmed", reason: "r", evidence: [] },
      { index: 1, verdict: "unconfirmed", reason: "r", evidence: [] },
      { index: 2, verdict: "refuted", reason: "r", evidence: [] },
    ] };
    const { d, runs } = deps(find, verify);
    const states: string[] = [];
    const r = await runJob(d, summary(1), "/repo", (s) => states.push(s.kind === "running" ? s.pass : s.kind));
    expect(runs.map((x) => x.schema)).toEqual([FIND_SCHEMA, VERIFY_SCHEMA]);
    expect(states[0]).toBe("find");
    expect(states).toContain("verify");
    expect(r.findings.map((f) => [f.status, f.quote])).toEqual([
      ["confirmed", ["two"]],
      ["unconfirmed", ["old2", "old3"]],
    ]);
    expect(r.chapters).toEqual(find.chapters);
    expect(r.handled).toEqual({});
    expect(r.createdAt).toBe("2026-11-09T00:00:00.000Z");
    expect(d.readFileAt).toHaveBeenCalledWith("/repo", "H1", "a.ts");
    expect(d.readFileAt).toHaveBeenCalledWith("/repo", "MB1", "a.ts");
  });

  it("job skips verify when no candidates", async () => {
    const { d, runs } = deps({ chapters: [], findings: [cand({ evidence: [] })] });
    const r = await runJob(d, summary(1), "/repo", () => {});
    expect(runs).toHaveLength(1);
    expect(r.findings).toEqual([]);
    expect(r.chapters).toEqual([{ title: "Other", summary: "", paths: ["a.ts"] }]);
  });

  it("job uses detail head and base, not the summary's", async () => {
    const { d } = deps({ chapters: [], findings: [] });
    const r = await runJob(d, summary(7), "/repo", () => {});
    expect(d.prDetail).toHaveBeenCalledWith("github.com", "N7");
    expect(d.fetchPr).toHaveBeenCalledWith("/repo", "origin", 7, "main", "B7");
    expect(d.prHunks).toHaveBeenCalledWith("/repo", "B7", "H7");
    expect(d.prDiffText).toHaveBeenCalledWith("/repo", "MB7", "H7");
    expect(d.prCommitSubjects).toHaveBeenCalledWith("/repo", "MB7", "H7");
    expect([r.key, r.headSha, r.baseSha, r.mergeBase]).toEqual([summary(7).key, "H7", "B7", "MB7"]);
  });

  it("fails when the fetched head is not the detail's head", async () => {
    const { d } = deps({ chapters: [], findings: [] });
    d.fetchPr.mockResolvedValueOnce("H999");
    await expect(runJob(d, summary(1), "/repo", () => {})).rejects.toThrow(/changed/);
  });
});

describe("runner", () => {
  it("job result is stored under its own key and head", async () => {
    const find = { chapters: [], findings: [cand({})] };
    const verify = { verdicts: [{ index: 0, verdict: "confirmed", reason: "r", evidence: [] }] };
    const { d } = deps(find, verify);
    const save = vi.fn(async (_r: AiResult) => {});
    const notify = vi.fn(async () => {});
    const c = ctx();
    const r = createRunner({ ctx: c, jobDeps: d, runJob, save, notify });
    requestJob(r, summary(1), "/repo");
    requestJob(r, summary(2), "/repo");
    expect(c.jobs[summary(2).key]).toEqual({ kind: "queued" });
    await flush();
    await flush();
    expect(save.mock.calls.map(([x]) => [x.key, x.headSha])).toEqual([
      [summary(1).key, "H1"],
      [summary(2).key, "H2"],
    ]);
    expect(c.results[summary(1).key]?.headSha).toBe("H1");
    expect(c.jobs[summary(2).key]).toEqual({ kind: "done" });
    expect(notify).toHaveBeenCalledWith(1, "PR 1", 1);
    expect(c.queue).toEqual(emptyQueue());
  });

  it("malformed find output fails the job and stores nothing", async () => {
    const { d } = deps({ findings: [] });
    const save = vi.fn(async () => {});
    const c = ctx();
    const r = createRunner({ ctx: c, jobDeps: d, runJob, save, notify: vi.fn(async () => {}) });
    requestJob(r, summary(1), "/repo");
    await flush();
    expect(save).not.toHaveBeenCalled();
    expect(c.results).toEqual({});
    const s = c.jobs[summary(1).key];
    expect(s.kind === "failed" && s.message).toMatch(/ai-malformed/);
    expect(c.queue.running).toBeNull();
  });

  it("cancel stops the running job and starts the next", async () => {
    const { d, runs } = deps({ chapters: [], findings: [] });
    // The first run hangs until cancelled, then rejects like the backend does.
    let rejectFirst: (e: Error) => void = () => {};
    d.aiRun.mockImplementationOnce((_p, _prompt, schema) => {
      const cancel = vi.fn(() => rejectFirst(new Error("cancelled")));
      runs.push({ schema, cancel });
      return { done: new Promise((_, rej) => (rejectFirst = rej)), cancel };
    });
    const runJobSpy = vi.fn(runJob);
    const save = vi.fn(async (_r: AiResult) => {});
    const c = ctx();
    const r = createRunner({ ctx: c, jobDeps: d, runJob: runJobSpy, save, notify: vi.fn(async () => {}) });
    const [a, b] = [summary(1), summary(2)];
    requestJob(r, a, "/repo");
    requestJob(r, b, "/repo");
    await flush();
    expect(c.jobs[a.key]?.kind).toBe("running");
    expect(runJobSpy).toHaveBeenCalledTimes(1);

    cancelJob(r, a.key);
    expect(runs[0].cancel).toHaveBeenCalled();
    expect(c.jobs[a.key]).toBeUndefined();
    expect(c.queue.running).toBe(b.key);
    expect(runJobSpy).toHaveBeenCalledTimes(2);
    await flush();
    await flush();
    expect(c.jobs[a.key]).toBeUndefined();
    expect(c.jobs[b.key]).toEqual({ kind: "done" });
    expect(save.mock.calls.map(([x]) => x.key)).toEqual([b.key]);
    expect(c.queue).toEqual(emptyQueue());
  });

  it("cancel of a waiting job drops it without touching the running one", async () => {
    const { d } = deps({ chapters: [], findings: [] });
    const c = ctx();
    const r = createRunner({ ctx: c, jobDeps: d, runJob, save: vi.fn(async () => {}), notify: vi.fn(async () => {}) });
    requestJob(r, summary(1), "/repo");
    requestJob(r, summary(2), "/repo");
    cancelJob(r, summary(2).key);
    expect(c.jobs[summary(2).key]).toBeUndefined();
    await flush();
    expect(c.jobs[summary(1).key]).toEqual({ kind: "done" });
    expect(d.prDetail).toHaveBeenCalledTimes(1);
  });
});
