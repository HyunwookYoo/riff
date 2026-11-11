import type { FileCompare } from "../gh";
import type { ApiDoc, DocsInfo } from "../../types";
import type { FileHunks, PrDetail, PrHunks, PrKey, PrSummary, ReviewThread } from "../types";
import type { aiRun } from "./run";
import { verdictReactions, type Reaction } from "./memory";
import { trimDiff } from "./diffTrim";
import { ROBLOX_SCHEMA, VERIFY_SCHEMA, findPrompt, findSchema, robloxPrompt, verifyPrompt, type RobloxReference } from "./prompts";
import { fillQuotes, mergeVerdicts, normalizeFind, normalizeRoblox } from "./result";
import { citedDocs, downgradeUnchecked, robloxApisOf } from "./roblox";
import { repoRules } from "./repoRules";
import type { AiChoice } from "./modelChoice";
import { cancel, enqueue, finish, type JobKind, type Queue, type QueueEntry } from "./queue";
import type { runRereview } from "./rereview";
import type { AiFinding, AiJobState, AiResult, RereviewResult, RobloxParity } from "./types";

export interface JobDeps {
  fetchPr: (path: string, remote: string, number: number, baseRef: string, baseSha: string) => Promise<string>;
  prDetail: (host: string, nodeId: string) => Promise<PrDetail>;
  prHunks: (path: string, base: string, head: string) => Promise<PrHunks>;
  prDiffText: (path: string, mergeBase: string, head: string) => Promise<string>;
  prCommitSubjects: (path: string, mergeBase: string, head: string) => Promise<string[]>;
  readFileAt: (path: string, rev: string, filePath: string) => Promise<string>;
  treePaths: (path: string, rev: string, prefix: string) => Promise<string[]>;
  prFileCompare: (path: string, base: string, oldHead: string, newHead: string, files: string[]) => Promise<FileCompare[]>;
  fetchCommit: (path: string, remote: string, sha: string) => Promise<void>;
  /** riff's copy of the Roblox API reference (see git.ts robloxDocsUpdate/Info/Read). */
  robloxDocs: {
    update: () => Promise<DocsInfo>;
    info: () => Promise<DocsInfo | null>;
    read: (sha: string, names: string[]) => Promise<ApiDoc[]>;
  };
  aiRun: typeof aiRun;
  now: () => number;
}

/**
 * The `instructions` for `aiRun`: the base branch's CLAUDE.md at the merge-base, which the PR
 * can't change (the checkout may be the PR branch); null if it is missing or unreadable.
 */
export function baseInstructions(d: JobDeps, repoPath: string, mergeBase: string): Promise<string | null> {
  return d.readFileAt(repoPath, mergeBase, "CLAUDE.md").catch(() => null);
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

/** The reference files for `apis`, from a freshly fetched copy or else the last one; or why there are none. */
async function robloxReference(d: JobDeps, apis: string[]): Promise<{ info: DocsInfo; docs: ApiDoc[] } | { skipped: string }> {
  const info = await d.robloxDocs.update().catch(() => d.robloxDocs.info().catch(() => null));
  if (!info) return { skipped: "Roblox docs not downloaded" };
  const docs = await d.robloxDocs.read(info.sha, apis).catch(() => null);
  if (!docs) return { skipped: "Roblox docs could not be read" };
  if (!docs.length) return { skipped: "no Roblox reference for the APIs the change touches" };
  return { info, docs };
}

/** The CLI's own model and effort. */
export const CLI_DEFAULT: AiChoice = { model: null, effort: null };

/**
 * Find → verify for one PR, at the PR's current head (from a fresh detail, not `pr`). With
 * `roblox` (parity on for the repo), a Roblox pass runs between them when find names Roblox
 * APIs; verify then checks its candidates too. Every pass runs with `choice`, which the result
 * records.
 */
export async function runJob(
  d: JobDeps, pr: PrSummary, repoPath: string, onState: (s: AiJobState) => void, choice: AiChoice = CLI_DEFAULT,
  roblox = false,
): Promise<AiResult> {
  const startedAt = d.now();
  onState({ kind: "running", pass: "find", startedAt, lastActivity: null });
  const detail = await d.prDetail(pr.repo.host, pr.nodeId);
  const head = detail.headSha;
  const base = detail.baseSha;
  const fetched = await d.fetchPr(repoPath, pr.remote, pr.number, pr.baseRef, base);
  if (fetched !== head) throw new Error("The PR changed while it was being fetched; analyse again.");
  const { mergeBase, files } = await d.prHunks(repoPath, base, head);
  const [fullDiff, commits, instructions, rules] = await Promise.all([
    d.prDiffText(repoPath, mergeBase, head),
    d.prCommitSubjects(repoPath, mergeBase, head),
    baseInstructions(d, repoPath, mergeBase),
    repoRules(d, repoPath, mergeBase),
  ]);

  const pass = async (which: "find" | "roblox" | "verify", prompt: string, schema: object): Promise<unknown> => {
    onState({ kind: "running", pass: which, startedAt, lastActivity: null });
    const run = d.aiRun(repoPath, prompt, schema, (t) =>
      onState({ kind: "running", pass: which, startedAt, lastActivity: t }), instructions, choice);
    return run.done;
  };

  const { diff, omitted } = trimDiff(fullDiff);
  const content = { repoPath, pr, detail, commits, mergeBase, head, diff, omitted, rules };
  const found = await pass("find", findPrompt({ ...content, roblox }), findSchema(roblox));
  const { chapters, candidates } = normalizeFind(found, files);
  let parity: RobloxParity | undefined;
  let reference: RobloxReference | undefined; // set when the Roblox pass ran
  const apis = roblox ? robloxApisOf(found) : [];
  if (roblox && !apis.length) parity = { skipped: "the change touches no Roblox API" };
  if (apis.length) {
    onState({ kind: "running", pass: "roblox", startedAt, lastActivity: null });
    const ref = await robloxReference(d, apis);
    if ("skipped" in ref) parity = ref;
    else {
      parity = { docsSha: ref.info.sha, docsDate: ref.info.date };
      reference = { sha: ref.info.sha, docs: ref.docs };
      const answer = await pass("roblox", robloxPrompt({ ...content, reference }), ROBLOX_SCHEMA);
      candidates.push(...normalizeRoblox(answer, files));
    }
  }
  let findings: AiFinding[] = [];
  if (candidates.length) {
    const cited = reference && { ...reference, docs: citedDocs(candidates.filter((c) => c.tag === "roblox"), reference.docs) };
    const verdicts = await pass(
      "verify",
      verifyPrompt({ repo: pr.repo, repoPath, head, mergeBase, rules, reference: cited, candidates: candidates.map((c, index) => ({ index, ...c })) }),
      VERIFY_SCHEMA,
    );
    findings = downgradeUnchecked(mergeVerdicts(candidates, verdicts), reference?.docs ?? []);
  }
  findings = fillQuotes(findings, await findingTexts(d, repoPath, findings, files, mergeBase, head));
  return {
    version: 1, key: pr.key, headSha: head, baseSha: base, mergeBase,
    createdAt: new Date(d.now()).toISOString(), chapters, findings, handled: {},
    model: choice.model, effort: choice.effort,
    ...(parity ? { roblox: parity } : {}),
  };
}

/**
 * The state the runner drives; in the app, the `aiState` rune object. `jobs` holds review
 * jobs only (the PR list's AI badge reads it); re-review jobs are in `rereviewJobs`.
 */
export interface AiCtx {
  queue: Queue;
  jobs: Record<PrKey, AiJobState>;
  rereviewJobs: Record<PrKey, AiJobState>;
  results: Record<PrKey, AiResult | null>;
}

export interface RunnerDeps {
  ctx: AiCtx;
  jobDeps: JobDeps;
  runJob: typeof runJob;
  runRereview: typeof runRereview;
  /** Saves a new review; resolves to what was stored (the PR's re-review is kept in it). */
  save: (r: AiResult) => Promise<AiResult>;
  /** Stores `rr` into `key`'s result, keeping the review in it, and updates `ctx.results`. */
  saveRereview: (key: PrKey, rr: RereviewResult) => Promise<void>;
  notify: (number: number, title: string, findings: number) => Promise<void>;
  /** Records a review memory (best effort, never throws). */
  remember: (r: Reaction) => void;
}

interface Active { entry: QueueEntry; cancelled: boolean; cancel: () => void }
/**
 * `choice` and `roblox` (Roblox parity, reviews only) are fixed when the job is queued: a
 * settings change while it waits doesn't move it.
 */
interface Spec { pr: PrSummary; repoPath: string; login: string; choice: AiChoice; roblox: boolean }

const specKey = (e: QueueEntry): string => `${e.key}|${e.kind}`;

export interface Runner extends RunnerDeps {
  /** By `specKey`. `login` is whose threads a re-review checks ("" for a review). */
  specs: Map<string, Spec>;
  /** The job holding the slot; only it may free the slot when it settles. */
  active: Active | null;
}

export function createRunner(d: RunnerDeps): Runner {
  return { ...d, specs: new Map(), active: null };
}

function setJob(r: Runner, e: QueueEntry, s: AiJobState | null): void {
  const field = e.kind === "review" ? "jobs" : "rereviewJobs";
  const { [e.key]: _, ...rest } = r.ctx[field];
  r.ctx[field] = s ? { ...rest, [e.key]: s } : rest;
}

/** Queues `e` (no-op if already queued or running) and starts it if the slot is free. */
function request(r: Runner, e: QueueEntry, spec: Spec): void {
  const q = enqueue(r.ctx.queue, e);
  if (q === r.ctx.queue) return;
  r.specs.set(specKey(e), spec);
  r.ctx.queue = q;
  setJob(r, e, { kind: "queued" });
  if (q.running === null) startNext(r);
}

export function requestJob(r: Runner, pr: PrSummary, repoPath: string, choice: AiChoice = CLI_DEFAULT, roblox = false): void {
  request(r, { key: pr.key, kind: "review" }, { pr, repoPath, login: "", choice, roblox });
}

/** Queues a check of whether `pr`'s new commits address `login`'s open threads. */
export function requestRereview(
  r: Runner, pr: PrSummary, repoPath: string, login: string, choice: AiChoice = CLI_DEFAULT,
): void {
  request(r, { key: pr.key, kind: "rereview" }, { pr, repoPath, login, choice, roblox: false });
}

export function cancelJob(r: Runner, key: PrKey, kind: JobKind = "review"): void {
  const e: QueueEntry = { key, kind };
  const { q, killRunning } = cancel(r.ctx.queue, e);
  r.ctx.queue = q;
  if (!killRunning) {
    if (r.specs.delete(specKey(e))) setJob(r, e, null);
    return;
  }
  const a = r.active;
  if (a && specKey(a.entry) === specKey(e)) {
    a.cancelled = true;
    a.cancel();
  }
  setJob(r, e, null);
  startNext(r);
}

/** Frees the slot and runs the next waiting job, if any. */
export function startNext(r: Runner): void {
  r.active = null;
  const { q, next } = finish(r.ctx.queue);
  r.ctx.queue = q;
  if (next !== null) void runOne(r, next);
}

async function runOne(r: Runner, entry: QueueEntry): Promise<void> {
  const { key } = entry;
  const spec = r.specs.get(specKey(entry))!;
  r.specs.delete(specKey(entry));
  const a: Active = { entry, cancelled: false, cancel: () => {} };
  r.active = a;
  let threads: ReviewThread[] = []; // the PR's threads as the job last fetched them
  const jobDeps: JobDeps = {
    ...r.jobDeps,
    prDetail: async (host, nodeId) => {
      const detail = await r.jobDeps.prDetail(host, nodeId);
      threads = detail.threads;
      return detail;
    },
    aiRun: (path, prompt, schema, onActivity, instructions, choice) => {
      if (a.cancelled) return { done: Promise.reject(new Error("cancelled")), cancel: () => {} };
      const run = r.jobDeps.aiRun(path, prompt, schema, onActivity, instructions, choice);
      a.cancel = run.cancel;
      return run;
    },
  };
  const onState = (s: AiJobState) => {
    if (!a.cancelled) setJob(r, entry, s);
  };
  try {
    if (entry.kind === "rereview") {
      const rr = await r.runRereview(jobDeps, spec.pr, spec.repoPath, spec.login, onState, spec.choice);
      if (a.cancelled) return;
      await r.saveRereview(key, rr);
      if (a.cancelled) return;
      setJob(r, entry, { kind: "done" });
      for (const m of verdictReactions(rr, threads, spec.pr.repo)) r.remember(m);
      return;
    }
    const result = await r.runJob(jobDeps, spec.pr, spec.repoPath, onState, spec.choice, spec.roblox);
    if (a.cancelled) return;
    const saved = await r.save(result);
    r.ctx.results = { ...r.ctx.results, [key]: saved }; // keep memory in step with disk
    if (a.cancelled) return;
    setJob(r, entry, { kind: "done" });
    const confirmed = result.findings.filter((f) => f.status === "confirmed").length;
    void r.notify(spec.pr.number, spec.pr.title, confirmed);
  } catch (e) {
    if (!a.cancelled) setJob(r, entry, { kind: "failed", message: e instanceof Error ? e.message : String(e) });
  } finally {
    if (r.active === a) startNext(r);
  }
}
