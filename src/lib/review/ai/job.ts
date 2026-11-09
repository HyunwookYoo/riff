import type { FileHunks, PrDetail, PrHunks, PrKey, PrSummary } from "../types";
import type { aiRun } from "./run";
import { FIND_SCHEMA, VERIFY_SCHEMA, findPrompt, verifyPrompt } from "./prompts";
import { fillQuotes, mergeVerdicts, normalizeFind } from "./result";
import { cancel, enqueue, finish, type Queue } from "./queue";
import type { AiFinding, AiJobState, AiResult } from "./types";

export interface JobDeps {
  fetchPr: (path: string, remote: string, number: number, baseRef: string, baseSha: string) => Promise<string>;
  prDetail: (host: string, nodeId: string) => Promise<PrDetail>;
  prHunks: (path: string, base: string, head: string) => Promise<PrHunks>;
  prDiffText: (path: string, mergeBase: string, head: string) => Promise<string>;
  prCommitSubjects: (path: string, mergeBase: string, head: string) => Promise<string[]>;
  readFileAt: (path: string, rev: string, filePath: string) => Promise<string>;
  aiRun: typeof aiRun;
  now: () => number;
}

/** Full text per `${path}|${side}` of the findings: RIGHT at head, LEFT at the merge-base. */
async function findingTexts(
  d: JobDeps, repoPath: string, findings: AiFinding[], files: FileHunks[], mergeBase: string, head: string,
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  const wanted = new Set(findings.map((f) => `${f.path}|${f.side}`));
  await Promise.all([...wanted].map(async (k) => {
    const sep = k.lastIndexOf("|");
    const path = k.slice(0, sep);
    const [rev, file] = k.slice(sep + 1) === "RIGHT"
      ? [head, path]
      : [mergeBase, files.find((f) => f.path === path)?.oldPath ?? path];
    try {
      texts.set(k, await d.readFileAt(repoPath, rev, file));
    } catch {
      // absent on this side (added/deleted): fillQuotes drops the finding
    }
  }));
  return texts;
}

/** Find → verify for one PR, at the PR's current head (from a fresh detail, not `pr`). */
export async function runJob(
  d: JobDeps, pr: PrSummary, repoPath: string, onState: (s: AiJobState) => void,
): Promise<AiResult> {
  const startedAt = d.now();
  onState({ kind: "running", pass: "find", startedAt, lastActivity: null });
  const detail = await d.prDetail(pr.repo.host, pr.nodeId);
  const head = detail.headSha;
  const base = detail.baseSha;
  const fetched = await d.fetchPr(repoPath, pr.remote, pr.number, pr.baseRef, base);
  if (fetched !== head) throw new Error("The PR changed while it was being fetched; analyse again.");
  const { mergeBase, files } = await d.prHunks(repoPath, base, head);
  const [diff, commits, instructions] = await Promise.all([
    d.prDiffText(repoPath, mergeBase, head),
    d.prCommitSubjects(repoPath, mergeBase, head),
    // The base branch's, which the PR can't change (the checkout may be the
    // PR branch); none if it is missing or unreadable.
    d.readFileAt(repoPath, mergeBase, "CLAUDE.md").catch(() => null),
  ]);

  const pass = async (which: "find" | "verify", prompt: string, schema: object): Promise<unknown> => {
    onState({ kind: "running", pass: which, startedAt, lastActivity: null });
    const run = d.aiRun(repoPath, prompt, schema, (t) =>
      onState({ kind: "running", pass: which, startedAt, lastActivity: t }), instructions);
    return run.done;
  };

  const found = await pass("find", findPrompt({ repoPath, pr, detail, commits, mergeBase, head, diff }), FIND_SCHEMA);
  const { chapters, candidates } = normalizeFind(found, files);
  let findings: AiFinding[] = [];
  if (candidates.length) {
    const verdicts = await pass(
      "verify",
      verifyPrompt({ repoPath, head, mergeBase, candidates: candidates.map((c, index) => ({ index, ...c })) }),
      VERIFY_SCHEMA,
    );
    findings = mergeVerdicts(candidates, verdicts);
  }
  findings = fillQuotes(findings, await findingTexts(d, repoPath, findings, files, mergeBase, head));
  return {
    version: 1, key: pr.key, headSha: head, baseSha: base, mergeBase,
    createdAt: new Date(d.now()).toISOString(), chapters, findings, handled: {},
  };
}

/** The state the runner drives; in the app, the `aiState` rune object. */
export interface AiCtx {
  queue: Queue;
  jobs: Record<PrKey, AiJobState>;
  results: Record<PrKey, AiResult | null>;
}

export interface RunnerDeps {
  ctx: AiCtx;
  jobDeps: JobDeps;
  runJob: typeof runJob;
  save: (r: AiResult) => Promise<void>;
  notify: (number: number, title: string, findings: number) => Promise<void>;
}

interface Active { key: PrKey; cancelled: boolean; cancel: () => void }

export interface Runner extends RunnerDeps {
  specs: Map<PrKey, { pr: PrSummary; repoPath: string }>;
  /** The job holding the slot; only it may free the slot when it settles. */
  active: Active | null;
}

export function createRunner(d: RunnerDeps): Runner {
  return { ...d, specs: new Map(), active: null };
}

function setJob(r: Runner, key: PrKey, s: AiJobState | null): void {
  const { [key]: _, ...rest } = r.ctx.jobs;
  r.ctx.jobs = s ? { ...rest, [key]: s } : rest;
}

/** Queues `pr` (no-op if already queued or running) and starts it if the slot is free. */
export function requestJob(r: Runner, pr: PrSummary, repoPath: string): void {
  const q = enqueue(r.ctx.queue, pr.key);
  if (q === r.ctx.queue) return;
  r.specs.set(pr.key, { pr, repoPath });
  r.ctx.queue = q;
  setJob(r, pr.key, { kind: "queued" });
  if (q.running === null) startNext(r);
}

export function cancelJob(r: Runner, key: PrKey): void {
  const { q, killRunning } = cancel(r.ctx.queue, key);
  r.ctx.queue = q;
  if (!killRunning) {
    if (r.specs.delete(key)) setJob(r, key, null);
    return;
  }
  const a = r.active;
  if (a && a.key === key) {
    a.cancelled = true;
    a.cancel();
  }
  setJob(r, key, null);
  startNext(r);
}

/** Frees the slot and runs the next waiting job, if any. */
export function startNext(r: Runner): void {
  r.active = null;
  const { q, next } = finish(r.ctx.queue);
  r.ctx.queue = q;
  if (next !== null) void runOne(r, next);
}

async function runOne(r: Runner, key: PrKey): Promise<void> {
  const spec = r.specs.get(key)!;
  r.specs.delete(key);
  const a: Active = { key, cancelled: false, cancel: () => {} };
  r.active = a;
  const jobDeps: JobDeps = {
    ...r.jobDeps,
    aiRun: (path, prompt, schema, onActivity, instructions) => {
      if (a.cancelled) return { done: Promise.reject(new Error("cancelled")), cancel: () => {} };
      const run = r.jobDeps.aiRun(path, prompt, schema, onActivity, instructions);
      a.cancel = run.cancel;
      return run;
    },
  };
  try {
    const result = await r.runJob(jobDeps, spec.pr, spec.repoPath, (s) => {
      if (!a.cancelled) setJob(r, key, s);
    });
    if (a.cancelled) return;
    await r.save(result);
    r.ctx.results = { ...r.ctx.results, [key]: result }; // saved: keep memory in step with disk
    if (a.cancelled) return;
    setJob(r, key, { kind: "done" });
    const confirmed = result.findings.filter((f) => f.status === "confirmed").length;
    void r.notify(spec.pr.number, spec.pr.title, confirmed);
  } catch (e) {
    if (!a.cancelled) setJob(r, key, { kind: "failed", message: e instanceof Error ? e.message : String(e) });
  } finally {
    if (r.active === a) startNext(r);
  }
}
