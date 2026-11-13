import { appState } from "../../store.svelte";
import { readFileAt, robloxDocsInfo, robloxDocsRead, robloxDocsUpdate, treePaths } from "../../git";
import { fetchCommit, fetchPr, listReviews, prCommitSubjects, prDiffText, prFileCompare, prHunks } from "../gh";
import { prDetail } from "../github";
import type { PrKey, PrSummary } from "../types";
import { loadAiResult, saveAiResult } from "./aiStore";
import { cancelJob, createRunner, requestJob, requestRereview, runJob } from "./job";
import { recordReaction } from "./memory";
import type { AiChoice } from "./modelChoice";
import { notifyReady } from "./notify";
import { repoKey } from "./roblox";
import { emptyQueue, type Queue } from "./queue";
import { runRereview, withRereview } from "./rereview";
import { aiRun } from "./run";
import { applyHandled } from "./result";
import type { AiJobState, AiResult, RereviewResult } from "./types";

export { isStale } from "./aiStore";
export { aiBadge, aiBadgeTitle, aiErrorText, rereviewButtonState, shouldLoad } from "./badge";
import { planLoads, shouldLoad } from "./badge";

class AiState {
  queue = $state<Queue>(emptyQueue());
  /** Review jobs (the PR list's AI badge); re-review jobs are in `rereviewJobs`. */
  jobs = $state<Record<PrKey, AiJobState>>({});
  rereviewJobs = $state<Record<PrKey, AiJobState>>({});
  /** Loaded lazily per PR; null = nothing cached (or unreadable). */
  results = $state<Record<PrKey, AiResult | null>>({});
}

export const aiState = new AiState();

// Saves of one PR's result run in order; `written` is the last result saved per PR.
const writes = new Map<PrKey, Promise<void>>();
const written = new Map<PrKey, AiResult>();

function queueWrite(key: PrKey, step: () => Promise<void>): Promise<void> {
  const p = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(step);
  writes.set(key, p);
  return p;
}

/** In a write step: `key`'s result as it is now. Memory leads the disk once loaded. */
async function current(key: PrKey): Promise<AiResult | null> {
  return key in aiState.results ? aiState.results[key] : loadAiResult(key);
}

/** Saves a new review, keeping the PR's re-review (it is about the threads, not this review). */
async function saveResult(r: AiResult): Promise<AiResult> {
  let saved = r;
  await queueWrite(r.key, async () => {
    const rr = (await current(r.key).catch(() => null))?.rereview;
    saved = rr ? { ...r, rereview: rr } : r;
    await saveAiResult(saved);
    written.set(r.key, saved);
  });
  return saved;
}

/** Stores `rr` into `key`'s result without dropping the review in it (or creates one). */
function saveRereview(key: PrKey, rr: RereviewResult): Promise<void> {
  return queueWrite(key, async () => {
    // Not caught: if the store can't be read, failing beats overwriting a review.
    const next = withRereview(await current(key), key, rr);
    await saveAiResult(next);
    written.set(key, next);
    aiState.results = { ...aiState.results, [key]: next };
  });
}

const runner = createRunner({
  ctx: aiState,
  jobDeps: {
    fetchPr, prDetail, prHunks, prDiffText, prCommitSubjects, readFileAt, treePaths, prFileCompare, fetchCommit, aiRun,
    robloxDocs: { update: robloxDocsUpdate, info: robloxDocsInfo, read: robloxDocsRead },
    now: Date.now,
  },
  runJob,
  runRereview,
  save: saveResult,
  saveRereview,
  notify: notifyReady,
  remember: recordReaction,
});

/** The model/effort the settings name for a run nobody overrode. */
export function aiDefaults(): AiChoice {
  return { model: appState.aiModel, effort: appState.aiEffort };
}

/**
 * Queues an AI review of `pr` (only ever on the user's request), with `choice` or the defaults,
 * and Roblox parity if it is on for the repo now.
 */
export function requestAi(pr: PrSummary, choice: AiChoice = aiDefaults()): void {
  const roblox = appState.robloxParityRepos.includes(repoKey(pr.repo));
  requestJob(runner, pr, appState.repos[pr.repoIdx].path, choice, roblox);
}

export function cancelAi(key: PrKey): void {
  cancelJob(runner, key);
}

/** Queues a re-review of `login`'s open threads on `pr` (only ever on the user's request). */
export function requestRereviewAi(pr: PrSummary, login: string, choice: AiChoice = aiDefaults()): void {
  requestRereview(runner, pr, appState.repos[pr.repoIdx].path, login, choice);
}

export function cancelRereviewAi(key: PrKey): void {
  cancelJob(runner, key, "rereview");
}

/**
 * Records what the user did with finding `id` of the result created at `createdAt`, in memory
 * at once and then on disk. A no-op if `key`'s result is now another one.
 */
export function setHandled(key: PrKey, createdAt: string, id: string, how: "added" | "discarded"): Promise<void> {
  const next = applyHandled(aiState.results[key] ?? null, createdAt, id, how);
  if (!next) return Promise.resolve();
  aiState.results = { ...aiState.results, [key]: next };
  return queueWrite(key, async () => {
    // A newer run saved first: don't put the older result back on disk.
    if (written.get(key) && written.get(key)!.createdAt !== next.createdAt) return;
    // Memory has this mark and any re-review stored since; save that, not the snapshot.
    const now = aiState.results[key];
    const toSave = now && now.createdAt === next.createdAt ? now : next;
    await saveAiResult(toSave);
    written.set(key, toSave);
  });
}

const inFlight = new Set<PrKey>();

export async function loadResultFor(key: PrKey): Promise<void> {
  if (!shouldLoad(key, aiState.results, inFlight)) return;
  inFlight.add(key);
  try {
    await load(key);
  } finally {
    inFlight.delete(key);
  }
}

/**
 * `loadResultFor` each of `keys` that has a stored result; the rest are set to null
 * at once. One store listing instead of a `load_review` call per PR.
 */
export async function loadResultsFor(keys: PrKey[]): Promise<void> {
  if (!keys.some((k) => shouldLoad(k, aiState.results, inFlight))) return;
  let stored: Set<string>;
  try {
    stored = new Set(await listReviews());
  } catch {
    return; // store unreadable right now: leave them unloaded so a later render retries
  }
  const { load, none } = planLoads(keys, aiState.results, inFlight, stored);
  // In place, as in `load`; a job finishing later replaces the null.
  for (const k of none) aiState.results[k] = null;
  for (const k of load) void loadResultFor(k);
}

async function load(key: PrKey): Promise<void> {
  let r: AiResult | null;
  try {
    r = await loadAiResult(key);
  } catch {
    return; // store unreadable right now: leave it unloaded so a later open retries
  }
  // A job may have finished while loading; its result is newer.
  // Set in place: copying the map per loaded PR is quadratic over a long list.
  if (!(key in aiState.results)) aiState.results[key] = r;
}
