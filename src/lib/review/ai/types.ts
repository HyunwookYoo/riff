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
export interface AiResult {
  version: 1; key: PrKey; headSha: string; baseSha: string; mergeBase: string;
  createdAt: string; chapters: AiChapter[]; findings: AiFinding[];
  handled: Record<string, "added" | "discarded">;   // finding id → what the user did
}
export type AiJobState =
  | { kind: "queued" }
  | { kind: "running"; pass: "find" | "verify"; startedAt: number; lastActivity: string | null }
  | { kind: "done" }
  | { kind: "failed"; message: string };
