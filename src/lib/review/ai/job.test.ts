import { describe, expect, it, vi } from "vitest";
import { CLI_DEFAULT, cancelJob, createRunner, requestJob, requestRereview, runJob, type AiCtx, type JobDeps, type RunnerDeps } from "./job";
import { FIND_SCHEMA, ROBLOX_SCHEMA, VERIFY_SCHEMA, findSchema } from "./prompts";
import { emptyQueue } from "./queue";
import { REREVIEW_SCHEMA, runRereview } from "./rereview";
import type { AiChoice } from "./modelChoice";
import type { AiResult, RereviewResult } from "./types";
import type { PrDetail, PrSummary } from "../types";
import type { ApiDoc, DocsInfo } from "../../types";

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

const ev = [{ path: "a.ts", line: 2, quote: "const two = 2;" }];
/** A failure path that checks out against `deps`' a.ts at head. */
const trace = [
  { path: "a.ts", side: "RIGHT", line: 1, quote: "const one = 1;", note: "n" },
  { path: "a.ts", side: "RIGHT", line: 2, quote: "const two = 2;\nconst three = 3;", note: "n" },
];
const cand = (o: object) => ({ path: "a.ts", side: "RIGHT", line: 2, startLine: null, severity: "high", body: "b", evidence: ev,
  failureScenario: "s", ...o });

/** Deps for a repo where node `N<n>` has head `H<n>`, base `B<n>`, merge-base `MB<n>`. */
function deps(find: unknown, verify: unknown = { verdicts: [] }, roblox: unknown = { findings: [] }) {
  const runs: { schema: object; instructions: string | null; choice: AiChoice; cancel: ReturnType<typeof vi.fn> }[] = [];
  const d = {
    fetchPr: vi.fn(async (_p: string, _r: string, n: number) => `H${n}`),
    prDetail: vi.fn(async (_h: string, node: string) => detail(`H${node.slice(1)}`, `B${node.slice(1)}`)),
    prHunks: vi.fn(async (_p: string, base: string) => ({
      mergeBase: `MB${base.slice(1)}`,
      files: [{ path: "a.ts", oldPath: null, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 }] }],
    })),
    prDiffText: vi.fn(async () => "diff --git a/a.ts b/a.ts\n"),
    prCommitSubjects: vi.fn(async () => ["subject"]),
    readFileAt: vi.fn(async (_p: string, rev: string, path: string): Promise<string> => {
      if (path !== "a.ts") throw new Error("missing");
      return rev.startsWith("MB") ? "const old1 = 1;\nconst old2 = 2;\nconst old3 = 3;\n" : "const one = 1;\nconst two = 2;\nconst three = 3;\n";
    }),
    treePaths: vi.fn(async (_p: string, _rev: string, _prefix: string): Promise<string[]> => []),
    aiRun: vi.fn((_p: string, _prompt: string, schema: object, _a: (t: string) => void, instructions: string | null, choice: AiChoice) => {
      const cancel = vi.fn();
      runs.push({ schema, instructions, choice, cancel });
      const answer = schema === FIND_SCHEMA || schema === findSchema(true) ? find
        : schema === ROBLOX_SCHEMA ? roblox : schema === REREVIEW_SCHEMA ? { verdicts: [] } : verify;
      return { done: Promise.resolve(answer), cancel };
    }),
    prFileCompare: vi.fn(async (_p: string, _b: string, _o: string, _n: string, files: string[]) =>
      files.map((path) => ({ path, oldPatch: "", newPatch: "" }))),
    fetchCommit: vi.fn(async () => {}),
    robloxDocs: {
      update: vi.fn(async (): Promise<DocsInfo> => ({ sha: "d0c5", date: "2026-11-10T08:00:00+09:00" })),
      info: vi.fn(async (): Promise<DocsInfo | null> => null),
      // The clone knows BasePart and Humanoid only.
      read: vi.fn(async (_sha: string, names: string[]): Promise<ApiDoc[]> => names
        .filter((n) => n === "BasePart" || n === "Humanoid")
        .map((n) => ({ name: n, path: `classes/${n}.yaml`, text: `name: ${n}\ndescription: ${n} doc text\n` }))),
    },
    now: () => Date.UTC(2026, 10, 9),
  } satisfies JobDeps;
  return { d, runs };
}

const ctx = (): AiCtx => ({ queue: emptyQueue(), jobs: {}, rereviewJobs: {}, results: {} });

/** Gives every PR one open thread started by "me". */
function withMyThread(d: ReturnType<typeof deps>["d"]): void {
  d.prDetail.mockImplementation(async (_h: string, node: string) => ({
    ...detail(`H${node.slice(1)}`, `B${node.slice(1)}`),
    threads: [{ id: "t1", path: "a.ts", side: "RIGHT", line: 1, startLine: null, originalLine: 1, isResolved: false,
      isOutdated: false, subjectType: "LINE", comments: [{ id: "c", author: "me", body: "b", createdAt: "" }] }],
  }));
}

/** Runner deps with no-op re-review plumbing; tests override what they check. */
const runnerDeps = (o: Partial<RunnerDeps> & Pick<RunnerDeps, "ctx" | "jobDeps">): RunnerDeps => ({
  runJob, runRereview, save: vi.fn(async (x: AiResult) => x), saveRereview: vi.fn(async () => {}), notify: vi.fn(async () => {}),
  remember: vi.fn(), ...o,
});

describe("runJob", () => {
  it("job runs find then verify and returns confirmed+unconfirmed", async () => {
    const find = {
      chapters: [{ title: "T", summary: "s", paths: ["a.ts"] }],
      findings: [cand({}), cand({ side: "LEFT", line: 3, startLine: 2 }), cand({ line: 1 })],
    };
    const verify = { verdicts: [
      { index: 0, verdict: "confirmed", reason: "r", evidence: [], trace },
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
      ["confirmed", ["const two = 2;"]],
      ["unconfirmed", ["const old2 = 2;", "const old3 = 3;"]],
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
    expect(r.refuted).toEqual([]);
    expect(r.chapters).toEqual([{ title: "Other", summary: "", paths: ["a.ts"] }]);
  });

  it("keeps refuted candidates with their reasons and checks evidence and failure paths against the code", async () => {
    const find = { chapters: [], findings: [
      cand({ body: "real" }),
      cand({ body: "no path" }),
      cand({ body: "bad step" }),
      cand({ body: "made-up evidence", evidence: [{ path: "a.ts", line: 2, quote: "two and a half" }] }),
      cand({ body: "old side", evidence: [...ev, { path: "a.ts", line: 2, quote: "const old2 = 2;" }, { path: "a.ts", line: 9, quote: "const nine = 9;" }] }),
      cand({ body: "\nwrong\nmore" }),
    ] };
    const verify = { verdicts: [
      { index: 0, verdict: "confirmed", reason: "seen", evidence: [], trace },
      { index: 1, verdict: "confirmed", reason: "r", evidence: [], trace: [] },
      { index: 2, verdict: "confirmed", reason: "r", evidence: [], trace: [trace[0], { ...trace[1], side: "LEFT" }] },
      { index: 3, verdict: "confirmed", reason: "r", evidence: [], trace },
      { index: 4, verdict: "confirmed", reason: "r", evidence: [], trace },
      { index: 5, verdict: "refuted", reason: "guarded", evidence: [], trace: [] },
    ] };
    const { d } = deps(find, verify);
    const r = await runJob(d, summary(1), "/repo", () => {});
    expect(r.findings.map((f) => [f.body, f.status, f.verification?.problem])).toEqual([
      ["real", "confirmed", undefined],
      ["no path", "unconfirmed", "no failure path"],
      ["bad step", "unconfirmed", "step 2 not found in a.ts:2"],
      ["made-up evidence", "unconfirmed", "evidence not found in the code"],
      ["old side", "confirmed", undefined],
    ]);
    expect(r.findings[0].verification).toEqual({ reason: "seen", trace });
    expect(r.findings[4].evidence.map((e) => e.quote)).toEqual(["const two = 2;", "const old2 = 2;"]);
    expect(r.refuted).toEqual([{ path: "a.ts", side: "RIGHT", line: 2, severity: "high", summary: "wrong", reason: "guarded" }]);
  });

  it("find gets the diff without asset sections, and the verify pass gets the scenarios", async () => {
    const { d } = deps({ chapters: [], findings: [cand({ failureScenario: "scenario one" })] });
    d.prDiffText.mockResolvedValueOnce(
      "diff --git a/a.ts b/a.ts\n+code\ndiff --git a/Hero.uasset b/Hero.uasset\nBinary files a/Hero.uasset and b/Hero.uasset differ\n");
    await runJob(d, summary(1), "/repo", () => {});
    const [find, verify] = d.aiRun.mock.calls.map((c) => c[1]);
    expect(find).toContain("diff --git a/a.ts b/a.ts\n+code");
    expect(find).not.toContain("diff --git a/Hero.uasset");
    expect(find).toContain("1 asset files were left out of the diff:");
    expect(verify).toContain("scenario one");
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

  it("both passes get CLAUDE.md as of the merge-base, or none", async () => {
    const find = { chapters: [], findings: [cand({})] };
    const { d, runs } = deps(find, { verdicts: [] });
    const read = d.readFileAt.getMockImplementation()!;
    d.readFileAt.mockImplementation(async (p, rev, path) =>
      path === "CLAUDE.md" ? `rules at ${rev}` : read(p, rev, path));
    await runJob(d, summary(1), "/repo", () => {});
    expect(d.readFileAt).toHaveBeenCalledWith("/repo", "MB1", "CLAUDE.md");
    expect(runs.map((x) => x.instructions)).toEqual(["rules at MB1", "rules at MB1"]);

    // No CLAUDE.md there (the default mock throws for it): no instructions.
    const missing = deps(find, { verdicts: [] });
    await runJob(missing.d, summary(1), "/repo", () => {});
    expect(missing.runs.map((x) => x.instructions)).toEqual([null, null]);
  });

  it("both passes list the repo's skills as of the merge-base", async () => {
    const find = { chapters: [], findings: [cand({})] };
    const { d } = deps(find, { verdicts: [] });
    const read = d.readFileAt.getMockImplementation()!;
    d.treePaths.mockResolvedValue([".claude/skills/style/SKILL.md"]);
    d.readFileAt.mockImplementation(async (p, rev, path) =>
      path.endsWith("SKILL.md") ? `---\nname: style\ndescription: skill at ${rev}\n---\n` : read(p, rev, path));
    await runJob(d, summary(1), "/repo", () => {});
    expect(d.treePaths).toHaveBeenCalledTimes(1);
    expect(d.treePaths).toHaveBeenCalledWith("/repo", "MB1", ".claude/skills");
    const [findP, verifyP] = d.aiRun.mock.calls.map((c) => c[1]);
    for (const p of [findP, verifyP]) expect(p).toContain("- .claude/skills/style/SKILL.md — style: skill at MB1");
  });

  it("both passes run with the job's model/effort, and the result records them", async () => {
    const find = { chapters: [], findings: [cand({})] };
    const { d, runs } = deps(find, { verdicts: [] });
    const r = await runJob(d, summary(1), "/repo", () => {}, { model: "opus", effort: "high" });
    expect(runs.map((x) => x.choice)).toEqual([{ model: "opus", effort: "high" }, { model: "opus", effort: "high" }]);
    expect([r.model, r.effort]).toEqual(["opus", "high"]);

    const unset = deps(find, { verdicts: [] });
    const u = await runJob(unset.d, summary(1), "/repo", () => {}, { model: null, effort: null });
    expect(unset.runs.map((x) => x.choice)).toEqual([{ model: null, effort: null }, { model: null, effort: null }]);
    expect([u.model, u.effort]).toEqual([null, null]);
  });

  it("with Roblox parity off nothing about Roblox runs, even if the AI names APIs", async () => {
    const { d, runs } = deps({ chapters: [], findings: [cand({})], robloxApis: ["BasePart"] });
    const r = await runJob(d, summary(1), "/repo", () => {});
    expect(runs.map((x) => x.schema)).toEqual([FIND_SCHEMA, VERIFY_SCHEMA]);
    expect(d.aiRun.mock.calls[0][1]).not.toContain("robloxApis");
    expect(d.robloxDocs.update).not.toHaveBeenCalled();
    expect(d.robloxDocs.read).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty("roblox");
  });

  it("with parity on and no Roblox API named: no docs update, no Roblox pass", async () => {
    const { d, runs } = deps({ chapters: [], findings: [cand({})], robloxApis: [] });
    const r = await runJob(d, summary(1), "/repo", () => {}, CLI_DEFAULT, true);
    expect(runs.map((x) => x.schema)).toEqual([findSchema(true), VERIFY_SCHEMA]);
    expect(d.aiRun.mock.calls[0][1]).toContain("3. robloxApis:");
    expect(d.robloxDocs.update).not.toHaveBeenCalled();
    expect(r.roblox).toEqual({ skipped: "the change touches no Roblox API" });
  });

  it("with parity on: find, Roblox pass on the read reference, one verify for all", async () => {
    const find = { chapters: [], findings: [cand({ body: "find one" })], robloxApis: ["BasePart", "Nope"] };
    const rbx = { findings: [
      cand({ body: "checked", evidence: [...ev, { path: "roblox:classes/BasePart.yaml", line: 2, quote: "description: BasePart  doc\ntext" }] }),
      cand({ body: "made up", evidence: [...ev, { path: "roblox:classes/BasePart.yaml", line: 2, quote: "not in it" }] }),
      cand({ body: "no scenario", failureScenario: "" }),
    ] };
    const verify = { verdicts: [0, 1, 2].map((index) => ({ index, verdict: "confirmed", reason: "r", evidence: [], trace })) };
    const { d, runs } = deps(find, verify, rbx);
    const states: string[] = [];
    const choice = { model: "opus", effort: "high" };
    const r = await runJob(d, summary(1), "/repo", (s) => states.push(s.kind === "running" ? s.pass : s.kind), choice, true);
    expect(runs.map((x) => x.schema)).toEqual([findSchema(true), ROBLOX_SCHEMA, VERIFY_SCHEMA]);
    expect(runs.map((x) => x.choice)).toEqual([choice, choice, choice]);
    expect([...new Set(states)]).toEqual(["find", "roblox", "verify"]);
    expect(d.robloxDocs.update).toHaveBeenCalledTimes(1);
    expect(d.robloxDocs.read).toHaveBeenCalledWith("d0c5", ["BasePart", "Nope"]);
    const [, rbxPrompt, verifyPrompt] = d.aiRun.mock.calls.map((c) => c[1]);
    expect(rbxPrompt).toContain("creator-docs at d0c5");
    expect(rbxPrompt).toContain("roblox:classes/BasePart.yaml\n`````\nname: BasePart");
    expect(rbxPrompt).toContain("diff --git a/a.ts b/a.ts");
    expect(verifyPrompt).toContain("roblox:classes/BasePart.yaml\n`````\nname: BasePart");
    expect(verifyPrompt).toContain("find one");
    expect(r.findings.map((f) => [f.body, f.status, f.tag])).toEqual([
      ["find one", "confirmed", undefined],
      ["checked", "confirmed", "roblox"],
      ["made up", "unconfirmed", "roblox"],
    ]);
    expect(r.roblox).toEqual({ docsSha: "d0c5", docsDate: "2026-11-10T08:00:00+09:00" });
  });

  it("verify gets only the reference files the Roblox candidates cite", async () => {
    const find = { chapters: [], findings: [], robloxApis: ["BasePart", "Humanoid"] };
    const rbx = { findings: [cand({ evidence: [...ev, { path: "roblox:classes/Humanoid.yaml", line: 1, quote: "q" }] })] };
    const { d } = deps(find, { verdicts: [] }, rbx);
    await runJob(d, summary(1), "/repo", () => {}, CLI_DEFAULT, true);
    const [, rbxPrompt, verifyPrompt] = d.aiRun.mock.calls.map((c) => c[1]);
    expect(rbxPrompt).toContain("roblox:classes/BasePart.yaml");
    expect(verifyPrompt).toContain("roblox:classes/Humanoid.yaml\n`````");
    expect(verifyPrompt).not.toContain("roblox:classes/BasePart.yaml");
  });

  it("a failed docs update falls back to the last copy", async () => {
    const { d, runs } = deps({ chapters: [], findings: [], robloxApis: ["BasePart"] });
    d.robloxDocs.update.mockRejectedValueOnce(new Error("offline"));
    d.robloxDocs.info.mockResolvedValueOnce({ sha: "01d", date: "2026-10-01T00:00:00Z" });
    const r = await runJob(d, summary(1), "/repo", () => {}, CLI_DEFAULT, true);
    expect(d.robloxDocs.read).toHaveBeenCalledWith("01d", ["BasePart"]);
    expect(runs.map((x) => x.schema)).toEqual([findSchema(true), ROBLOX_SCHEMA]);
    expect(r.roblox).toEqual({ docsSha: "01d", docsDate: "2026-10-01T00:00:00Z" });
  });

  it("skips the Roblox pass, recording why, with no docs, unreadable docs or no reference for the APIs", async () => {
    const cases: [string, (d: ReturnType<typeof deps>["d"]) => void][] = [
      ["Roblox docs not downloaded", (d) => d.robloxDocs.update.mockRejectedValueOnce(new Error("offline"))],
      ["Roblox docs could not be read", (d) => d.robloxDocs.read.mockRejectedValueOnce(new Error("bad"))],
      ["no Roblox reference for the APIs the change touches", (d) => d.robloxDocs.read.mockResolvedValueOnce([])],
    ];
    for (const [why, arrange] of cases) {
      const { d, runs } = deps({ chapters: [], findings: [cand({})], robloxApis: ["BasePart"] });
      arrange(d);
      const r = await runJob(d, summary(1), "/repo", () => {}, CLI_DEFAULT, true);
      expect(runs.map((x) => x.schema), why).toEqual([findSchema(true), VERIFY_SCHEMA]);
      expect(r.roblox).toEqual({ skipped: why });
    }
  });

  it("a failed Roblox pass is recorded as skipped and verify runs on the find candidates", async () => {
    const cases: [string, unknown][] = [
      ["Roblox pass failed: CLI exited with code 1", new Error("CLI exited with code 1\nstack and more")],
      ["Roblox pass failed: rate limited", "rate limited"],
      ["Roblox pass failed: ai-malformed: findings missing", null], // a malformed answer
    ];
    for (const [why, failure] of cases) {
      const find = { chapters: [], findings: [cand({ body: "find one" })], robloxApis: ["BasePart"] };
      const verify = { verdicts: [{ index: 0, verdict: "confirmed", reason: "r", evidence: [], trace }] };
      const { d, runs } = deps(find, verify, failure === null ? { nope: 1 } : {});
      if (failure !== null) {
        const answer = d.aiRun.getMockImplementation()!;
        d.aiRun.mockImplementation((p, prompt, schema, a, instructions, choice) => schema === ROBLOX_SCHEMA
          ? { done: Promise.reject(failure), cancel: vi.fn() }
          : answer(p, prompt, schema, a, instructions, choice));
      }
      const r = await runJob(d, summary(1), "/repo", () => {}, CLI_DEFAULT, true);
      expect(r.roblox, why).toEqual({ skipped: why });
      if (failure === null) expect(runs.map((x) => x.schema)).toEqual([findSchema(true), ROBLOX_SCHEMA, VERIFY_SCHEMA]);
      const verifyPrompt = d.aiRun.mock.calls.find((c) => c[2] === VERIFY_SCHEMA)![1];
      expect(verifyPrompt, why).not.toContain("Roblox API reference (from");
      expect(r.findings.map((f) => [f.body, f.status])).toEqual([["find one", "confirmed"]]);
    }
  });

  it("a cancelled Roblox pass still aborts the job", async () => {
    for (const cancelled of ["cancelled", new Error("cancelled")]) {
      const { d } = deps({ chapters: [], findings: [cand({})], robloxApis: ["BasePart"] });
      const answer = d.aiRun.getMockImplementation()!;
      d.aiRun.mockImplementation((p, prompt, schema, a, instructions, choice) => schema === ROBLOX_SCHEMA
        ? { done: Promise.reject(cancelled), cancel: vi.fn() }
        : answer(p, prompt, schema, a, instructions, choice));
      await expect(runJob(d, summary(1), "/repo", () => {}, CLI_DEFAULT, true)).rejects.toBe(cancelled);
      expect(d.aiRun.mock.calls.map((c) => c[2])).toEqual([findSchema(true), ROBLOX_SCHEMA]);
    }
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
    const verify = { verdicts: [{ index: 0, verdict: "confirmed", reason: "r", evidence: [], trace }] };
    const { d } = deps(find, verify);
    const save = vi.fn(async (x: AiResult) => x);
    const notify = vi.fn(async () => {});
    const c = ctx();
    const r = createRunner(runnerDeps({ ctx: c, jobDeps: d, save, notify }));
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
    const save = vi.fn(async (x: AiResult) => x);
    const c = ctx();
    const r = createRunner(runnerDeps({ ctx: c, jobDeps: d, save }));
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
    d.aiRun.mockImplementationOnce((_p, _prompt, schema, _a, instructions, choice) => {
      const cancel = vi.fn(() => rejectFirst(new Error("cancelled")));
      runs.push({ schema, instructions, choice, cancel });
      return { done: new Promise((_, rej) => (rejectFirst = rej)), cancel };
    });
    const runJobSpy = vi.fn(runJob);
    const save = vi.fn(async (x: AiResult) => x);
    const c = ctx();
    const r = createRunner(runnerDeps({ ctx: c, jobDeps: d, runJob: runJobSpy, save }));
    const [a, b] = [summary(1), summary(2)];
    requestJob(r, a, "/repo");
    requestJob(r, b, "/repo");
    await flush();
    expect(c.jobs[a.key]?.kind).toBe("running");
    expect(runJobSpy).toHaveBeenCalledTimes(1);

    cancelJob(r, a.key);
    expect(runs[0].cancel).toHaveBeenCalled();
    expect(c.jobs[a.key]).toBeUndefined();
    expect(c.queue.running).toEqual({ key: b.key, kind: "review" });
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
    const r = createRunner(runnerDeps({ ctx: c, jobDeps: d }));
    requestJob(r, summary(1), "/repo");
    requestJob(r, summary(2), "/repo");
    cancelJob(r, summary(2).key);
    expect(c.jobs[summary(2).key]).toBeUndefined();
    await flush();
    expect(c.jobs[summary(1).key]).toEqual({ kind: "done" });
    expect(d.prDetail).toHaveBeenCalledTimes(1);
  });

  it("a re-review shares the queue but is tracked and saved apart from the review", async () => {
    const { d } = deps({ chapters: [], findings: [] });
    withMyThread(d);
    const save = vi.fn(async (x: AiResult) => x);
    const saveRereview = vi.fn(async (_k: string, _r: RereviewResult) => {});
    const notify = vi.fn(async () => {});
    const c = ctx();
    const r = createRunner(runnerDeps({ ctx: c, jobDeps: d, save, saveRereview, notify }));
    const pr = summary(1, { myLastReviewSha: "R1" });
    requestJob(r, pr, "/repo");
    requestRereview(r, pr, "/repo", "me");
    requestRereview(r, pr, "/repo", "me"); // already queued: no-op
    expect(c.jobs[pr.key]?.kind).toBe("running");
    expect(c.rereviewJobs[pr.key]).toEqual({ kind: "queued" });
    expect(c.queue.waiting).toEqual([{ key: pr.key, kind: "rereview" }]);
    await flush();
    await flush();
    expect(c.jobs[pr.key]).toEqual({ kind: "done" });
    expect(c.rereviewJobs[pr.key]).toEqual({ kind: "done" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(saveRereview).toHaveBeenCalledWith(pr.key, {
      fromHead: "R1", toHead: "H1", createdAt: "2026-11-09T00:00:00.000Z",
      verdicts: [{ threadId: "t1", verdict: "unclear", reason: "no answer", evidence: [] }],
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(c.queue).toEqual(emptyQueue());

    // Cancelling the waiting re-review leaves the review alone.
    requestJob(r, pr, "/repo");
    requestRereview(r, pr, "/repo", "me");
    cancelJob(r, pr.key, "rereview");
    expect(c.rereviewJobs[pr.key]).toBeUndefined();
    expect(c.jobs[pr.key]?.kind).not.toBeUndefined();
    await flush();
    expect(saveRereview).toHaveBeenCalledTimes(1);
  });

  it("a finished re-review records one memory per answered verdict, after saving", async () => {
    const { d } = deps({ chapters: [], findings: [] });
    withMyThread(d);
    const one = (await d.prDetail("h", "N1")).threads[0];
    d.prDetail.mockImplementation(async (_h: string, node: string) => ({
      ...detail(`H${node.slice(1)}`, `B${node.slice(1)}`), threads: [one, { ...one, id: "t2", path: "b.ts" }],
    }));
    // The AI answers t1 only; t2's filled-in "no answer" verdict is not a memory.
    d.aiRun.mockImplementation(() => ({
      done: Promise.resolve({ verdicts: [{ threadId: "t1", verdict: "addressed", reason: "r", evidence: [] }] }),
      cancel: vi.fn(),
    }));
    const order: string[] = [];
    const saveRereview = vi.fn(async () => { order.push("save"); });
    const remember = vi.fn(() => { order.push("remember"); });
    const r = createRunner(runnerDeps({ ctx: ctx(), jobDeps: d, saveRereview, remember }));
    requestRereview(r, summary(1, { myLastReviewSha: "R1" }), "/repo", "me");
    await flush();
    expect(order).toEqual(["save", "remember"]);
    expect(remember).toHaveBeenCalledWith({
      content: `riff review (o/r): reviewer's comment thread in "a.ts" was judged addressed`,
      project: "o/r", concepts: ["riff-review", "thread-addressed", "repo-o-r"],
    });
  });

  it("a job runs with the model/effort it was queued with", async () => {
    const { d, runs } = deps({ chapters: [], findings: [] });
    withMyThread(d);
    const r = createRunner(runnerDeps({ ctx: ctx(), jobDeps: d }));
    const a = { model: "opus", effort: "max" };
    const b = { model: null, effort: "low" };
    const c = { model: "claude-x[1m]", effort: null };
    requestJob(r, summary(1), "/repo", a);
    requestJob(r, summary(2), "/repo", b);
    requestRereview(r, summary(3, { myLastReviewSha: "R3" }), "/repo", "me", c);
    await flush();
    await flush();
    await flush();
    expect(runs.map((x) => [x.schema, x.choice])).toEqual([[FIND_SCHEMA, a], [FIND_SCHEMA, b], [REREVIEW_SCHEMA, c]]);
  });

  it("a review runs with the Roblox parity it was queued with, and cancel stops the Roblox pass", async () => {
    const { d, runs } = deps({ chapters: [], findings: [], robloxApis: ["BasePart"] });
    const runJobSpy = vi.fn(runJob);
    const c = ctx();
    const r = createRunner(runnerDeps({ ctx: c, jobDeps: d, runJob: runJobSpy }));
    // The Roblox pass hangs until cancelled.
    let rejectRoblox: (e: Error) => void = () => {};
    const answer = d.aiRun.getMockImplementation()!;
    d.aiRun.mockImplementation((p, prompt, schema, a, instructions, choice) => {
      if (schema !== ROBLOX_SCHEMA) return answer(p, prompt, schema, a, instructions, choice);
      const cancel = vi.fn(() => rejectRoblox(new Error("cancelled")));
      runs.push({ schema, instructions, choice, cancel });
      return { done: new Promise((_, rej) => (rejectRoblox = rej)), cancel };
    });
    requestJob(r, summary(1), "/repo", CLI_DEFAULT, true);
    requestJob(r, summary(2), "/repo");
    await flush();
    expect(runJobSpy.mock.calls[0][5]).toBe(true);
    expect(c.jobs[summary(1).key]).toMatchObject({ kind: "running", pass: "roblox" });
    cancelJob(r, summary(1).key);
    expect(runs[1].cancel).toHaveBeenCalled();
    await flush();
    await flush();
    expect(runJobSpy.mock.calls[1][5]).toBe(false);
    expect(runs.map((x) => x.schema)).toEqual([findSchema(true), ROBLOX_SCHEMA, FIND_SCHEMA]);
    expect(c.jobs[summary(1).key]).toBeUndefined();
    expect(c.jobs[summary(2).key]).toEqual({ kind: "done" });
  });

  it("a failed re-review stores nothing", async () => {
    const { d } = deps({ chapters: [], findings: [] });
    withMyThread(d);
    d.fetchCommit.mockRejectedValueOnce(new Error("gone"));
    const saveRereview = vi.fn(async () => {});
    const c = ctx();
    const r = createRunner(runnerDeps({ ctx: c, jobDeps: d, saveRereview }));
    requestRereview(r, summary(1, { myLastReviewSha: "R1" }), "/repo", "me");
    await flush();
    expect(saveRereview).not.toHaveBeenCalled();
    expect(r.remember).not.toHaveBeenCalled();
    const s = c.rereviewJobs[summary(1).key];
    expect(s?.kind === "failed" && s.message).toMatch(/isn't available/);
    expect(c.jobs).toEqual({});
  });
});
