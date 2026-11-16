import { invoke } from "@tauri-apps/api/core";
import type { GhRepo, ReviewThread } from "../types";
import { NO_ANSWER, type AiFinding, type ThreadCheck, type Verdict } from "./types";

/**
 * One review memory for agentmemory. Built only from enum words, a file path and the repo name —
 * never from PR text, comment bodies or AI-written prose (later AI runs recall these).
 */
export interface Reaction { content: string; project: string; concepts: string[] }

const cap = (s: string, n: number) => Array.from(s).slice(0, n).join("");

/** Letters, digits and `._-` only; every run of anything else becomes `_`. A name can't read as a sentence. */
const word = (s: string) => s.replace(/[^\p{L}\p{N}._-]+/gu, "_");

/** The path as an identifier-like name: `word` per segment, segments capped at 80 characters, the path at 200. */
function quotedPath(path: string): string {
  return JSON.stringify(cap(path.split("/").map((seg) => cap(word(seg), 80)).join("/"), 200));
}

/** `owner/name`, allow-listed like a path segment. Also how the prompts name the repo. */
export const repoName = (repo: GhRepo) => `${word(repo.owner)}/${word(repo.name)}`;

/** Prefix, project and repo concept every memory of `repo` carries. */
function scope(repo: GhRepo) {
  return {
    prefix: `riff review (${repoName(repo)}):`,
    project: repoName(repo),
    concept: `repo-${word(repo.owner)}-${word(repo.name)}`.toLowerCase(),
  };
}

const FINDING_WORDS = { added: "added to the draft", edited: "edited and added", discarded: "discarded" } as const;

export function findingReaction(f: AiFinding, how: "added" | "edited" | "discarded", repo: GhRepo): Reaction {
  const s = scope(repo);
  return {
    content: `${s.prefix} AI finding (severity ${f.severity}) in ${quotedPath(f.path)} was ${FINDING_WORDS[how]} by the reviewer`,
    project: s.project,
    concepts: ["riff-review", `ai-finding-${how}`, `severity-${f.severity}`, s.concept],
  };
}

const THREAD_WORDS: Record<"resolved" | Verdict, string> = {
  resolved: "resolved", addressed: "judged addressed", not_addressed: "judged not addressed", unclear: "judged unclear",
};

export function threadReaction(t: ReviewThread, outcome: "resolved" | Verdict, repo: GhRepo): Reaction {
  const s = scope(repo);
  return {
    content: `${s.prefix} reviewer's comment thread in ${quotedPath(t.path)} was ${THREAD_WORDS[outcome]}`,
    project: s.project,
    concepts: ["riff-review", `thread-${outcome}`, s.concept],
  };
}

/** The memory for resolving `t`, only if `login` started it (it's the reviewer's own thread). */
export function ownThreadResolved(t: ReviewThread, login: string, repo: GhRepo): Reaction | null {
  return t.comments[0]?.author === login ? threadReaction(t, "resolved", repo) : null;
}

/**
 * A check's verdict on the point in a re-review's words, so old and new memories compare: the
 * viewer's concern holding is not addressed, the author's counter-claim holding is addressed.
 * Null for a point someone else raised.
 */
function outcomeOf(c: ThreadCheck): Verdict | null {
  if (c.raisedBy === "other") return null;
  if (c.verdict === "unclear") return "unclear";
  return (c.verdict === "holds") === (c.raisedBy === "author") ? "addressed" : "not_addressed";
}

/**
 * One per check the AI answered whose thread is in `threads` and was started by `login`, unless
 * someone else raised its point. None on `login`'s own PR (`prAuthor`): these memories are about a
 * reviewer's threads, and there `login`'s points are the author's.
 */
export function threadCheckReactions(
  checks: ThreadCheck[], threads: ReviewThread[], repo: GhRepo, login: string, prAuthor: string,
): Reaction[] {
  if (login === prAuthor) return [];
  return checks.flatMap((c) => {
    const outcome = c.reason === NO_ANSWER ? null : outcomeOf(c);
    const t = threads.find((x) => x.id === c.threadId);
    return outcome && t?.comments[0]?.author === login ? [threadReaction(t, outcome, repo)] : [];
  });
}

/** Fire and forget: agentmemory may not be running, and that is fine. */
export function recordReaction(r: Reaction): void {
  invoke("record_review_memory", { content: r.content, project: r.project, concepts: r.concepts }).catch(() => {});
}
