import { invoke } from "@tauri-apps/api/core";
import type { GhRepo, ReviewThread } from "../types";
import type { AiFinding, RereviewResult, Verdict } from "./types";

/**
 * One review memory for agentmemory. Built only from enum words, a file path and the repo name —
 * never from PR text, comment bodies or AI-written prose (later AI runs recall these).
 */
export interface Reaction { content: string; project: string; concepts: string[] }

const MAX_PATH = 300;

/** The path as quoted data: control characters stripped, capped at `MAX_PATH` characters. */
function quotedPath(path: string): string {
  return JSON.stringify(Array.from(path.replace(/\p{Cc}/gu, "")).slice(0, MAX_PATH).join(""));
}

const project = (repo: GhRepo) => `${repo.owner}/${repo.name}`;

const FINDING_WORDS = { added: "added to the draft", edited: "edited and added", discarded: "discarded" } as const;

export function findingReaction(f: AiFinding, how: "added" | "edited" | "discarded", repo: GhRepo): Reaction {
  return {
    content: `riff review: AI finding (severity ${f.severity}) in ${quotedPath(f.path)} was ${FINDING_WORDS[how]} by the reviewer`,
    project: project(repo),
    concepts: ["riff-review", `ai-finding-${how}`, `severity-${f.severity}`],
  };
}

const THREAD_WORDS: Record<"resolved" | Verdict, string> = {
  resolved: "resolved", addressed: "judged addressed", not_addressed: "judged not addressed", unclear: "judged unclear",
};

export function threadReaction(t: ReviewThread, outcome: "resolved" | Verdict, repo: GhRepo): Reaction {
  return {
    content: `riff review: reviewer's comment thread in ${quotedPath(t.path)} was ${THREAD_WORDS[outcome]}`,
    project: project(repo),
    concepts: ["riff-review", `thread-${outcome}`],
  };
}

/** One per verdict of `rr` whose thread is in `threads`. */
export function verdictReactions(rr: RereviewResult, threads: ReviewThread[], repo: GhRepo): Reaction[] {
  return rr.verdicts.flatMap((v) => {
    const t = threads.find((x) => x.id === v.threadId);
    return t ? [threadReaction(t, v.verdict, repo)] : [];
  });
}

/** Fire and forget: agentmemory may not be running, and that is fine. */
export function recordReaction(r: Reaction): void {
  invoke("record_review_memory", { content: r.content, project: r.project, concepts: r.concepts }).catch(() => {});
}
