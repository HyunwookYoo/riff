import { appState } from "../../store.svelte";
import { readFileAt } from "../../git";
import { fetchPr, prCommitSubjects, prDiffText, prHunks } from "../gh";
import { prDetail } from "../github";
import type { PrKey, PrSummary } from "../types";
import { loadAiResult, saveAiResult } from "./aiStore";
import { cancelJob, createRunner, requestJob, runJob } from "./job";
import { notifyReady } from "./notify";
import { emptyQueue, type Queue } from "./queue";
import { aiRun } from "./run";
import type { AiJobState, AiResult } from "./types";

export { isStale } from "./aiStore";
export { aiBadge, aiErrorText, shouldLoad } from "./badge";
import { shouldLoad } from "./badge";

class AiState {
  queue = $state<Queue>(emptyQueue());
  jobs = $state<Record<PrKey, AiJobState>>({});
  /** Loaded lazily per PR; null = nothing cached (or unreadable). */
  results = $state<Record<PrKey, AiResult | null>>({});
}

export const aiState = new AiState();

const runner = createRunner({
  ctx: aiState,
  jobDeps: { fetchPr, prDetail, prHunks, prDiffText, prCommitSubjects, readFileAt, aiRun, now: Date.now },
  runJob,
  save: saveAiResult,
  notify: notifyReady,
});

/** Queues an AI review of `pr` (only ever on the user's request). */
export function requestAi(pr: PrSummary): void {
  requestJob(runner, pr, appState.repos[pr.repoIdx].path);
}

export function cancelAi(key: PrKey): void {
  cancelJob(runner, key);
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

async function load(key: PrKey): Promise<void> {
  let r: AiResult | null;
  try {
    r = await loadAiResult(key);
  } catch {
    return; // store unreadable right now: leave it unloaded so a later open retries
  }
  // A job may have finished while loading; its result is newer.
  if (!(key in aiState.results)) aiState.results = { ...aiState.results, [key]: r };
}
