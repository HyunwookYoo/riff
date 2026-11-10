import type { PrKey, Side } from "../types";
export type Severity = "high" | "medium" | "low";
export interface AiEvidence { path: string; line: number | null; quote: string }
export interface AiChapter { title: string; summary: string; paths: string[] }
export interface AiFinding {
  id: string;                 // stable within a result: `f${index}`
  path: string; side: Side; line: number; startLine: number | null;
  severity: Severity; body: string; evidence: AiEvidence[];
  status: "confirmed" | "unconfirmed";
  quote: string[];            // lines startLine..line of `side` at the analysed head/merge-base, filled by riff
}
export type Verdict = "addressed" | "not_addressed" | "unclear";
export interface ThreadVerdict { threadId: string; verdict: Verdict; reason: string; evidence: AiEvidence[] }
/** The `reason` of a verdict riff filled in because the AI gave none for the thread. */
export const NO_ANSWER = "no answer";
/** Whether the commits since my last submitted review (`fromHead`) address my open threads. */
export interface RereviewResult { fromHead: string; toHead: string; createdAt: string; verdicts: ThreadVerdict[] }
/** `headSha` is "" when no AI review ran yet and the record only holds a re-review (see `hasReview`). */
export interface AiResult {
  version: 1; key: PrKey; headSha: string; baseSha: string; mergeBase: string;
  createdAt: string; chapters: AiChapter[]; findings: AiFinding[];
  handled: Record<string, "added" | "discarded">;   // finding id → what the user did
  rereview?: RereviewResult;
  /** What the review ran with (null = the CLI's default); absent in records from before riff chose. */
  model?: string | null; effort?: string | null;
}
export type AiJobState =
  | { kind: "queued" }
  | { kind: "running"; pass: "find" | "verify" | "rereview"; startedAt: number; lastActivity: string | null }
  | { kind: "done" }
  | { kind: "failed"; message: string };
