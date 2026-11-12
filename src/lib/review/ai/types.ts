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
  /** The input or state that goes wrong and how; absent in records from before riff asked for it. */
  failureScenario?: string;
  /** "roblox": from the Roblox parity pass. */
  tag?: "roblox";
  /** The verify pass's answer; absent in records from before riff kept it. */
  verification?: Verification;
}
/** One step of a failure path, quoted from `path` at `side`'s revision. */
export interface TraceStep { path: string; side: Side; line: number; quote: string; note: string }
/**
 * `trace`: the failure path of a confirmed verdict ([] otherwise). `problem`: what riff's own
 * check of the quotes found wrong; the finding is then unconfirmed, whatever the verdict.
 * `unchecked`: a confirmed finding with a step riff couldn't read (too many files, or too large).
 */
export interface Verification { reason: string; trace: TraceStep[]; problem?: string; unchecked?: boolean }
/**
 * A candidate the verify pass refuted. `summary`: the first non-empty line of its body. `side`:
 * absent in records from before riff kept it (RIGHT).
 */
export interface RefutedFinding { path: string; side?: Side; line: number; severity: Severity; summary: string; reason: string }
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
  /** Roblox parity on: the reference commit the Roblox pass read, or why it didn't run. */
  roblox?: RobloxParity;
  /** Absent in records from before riff kept them. */
  refuted?: RefutedFinding[];
}
/** `docsDate`: the reference commit's ISO 8601 date. */
export type RobloxParity = { docsSha: string; docsDate: string } | { skipped: string };
export type AiJobState =
  | { kind: "queued" }
  | { kind: "running"; pass: "find" | "roblox" | "verify" | "rereview"; startedAt: number; lastActivity: string | null }
  | { kind: "done" }
  | { kind: "failed"; message: string };
