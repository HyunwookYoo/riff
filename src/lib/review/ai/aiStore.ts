import { loadReview, saveReview } from "../gh";
import type { PrKey } from "../types";
import type { AiResult } from "./types";

/** AI results share the review store with draft records, under their own key. */
export const aiKey = (prKey: PrKey): string => `${prKey}@ai`;
export const isAiKey = (key: string): boolean => key.endsWith("@ai");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isOptStr = (v: unknown): boolean => v === undefined || v === null || isStr(v);

const isEvidence = (v: unknown): boolean => Array.isArray(v) && v.every((e) =>
  isObj(e) && isStr(e.path) && (e.line === null || isInt(e.line)) && isStr(e.quote));

const isSeverity = (v: unknown): boolean => v === "high" || v === "medium" || v === "low";

const isStep = (s: unknown): boolean => isObj(s) && isStr(s.path) && (s.side === "LEFT" || s.side === "RIGHT")
  && isInt(s.line) && isStr(s.quote) && isStr(s.note) && (s.movedFrom === undefined || isInt(s.movedFrom));

const isVerification = (v: unknown): boolean => isObj(v) && isStr(v.reason)
  && Array.isArray(v.trace) && v.trace.every(isStep) && (v.problem === undefined || isStr(v.problem))
  && (v.unchecked === undefined || typeof v.unchecked === "boolean");

const isRefuted = (r: unknown): boolean => isObj(r) && isStr(r.path) && isInt(r.line) && isSeverity(r.severity)
  && isStr(r.summary) && isStr(r.reason) && (r.side === undefined || r.side === "LEFT" || r.side === "RIGHT");

function isFinding(f: unknown): boolean {
  return isObj(f) && isStr(f.id) && isStr(f.path) && (f.side === "LEFT" || f.side === "RIGHT")
    && isInt(f.line) && (f.startLine === null || isInt(f.startLine))
    && isSeverity(f.severity)
    && isStr(f.body) && (f.status === "confirmed" || f.status === "unconfirmed") && isStrs(f.quote)
    && isEvidence(f.evidence) && (f.failureScenario === undefined || isStr(f.failureScenario))
    && (f.tag === undefined || f.tag === "roblox")
    && (f.verification === undefined || isVerification(f.verification));
}

const isRobloxParity = (v: unknown): boolean =>
  isObj(v) && ((isStr(v.docsSha) && isStr(v.docsDate)) || isStr(v.skipped));

function isRereview(r: unknown): boolean {
  return isObj(r) && isStr(r.fromHead) && isStr(r.toHead) && isStr(r.createdAt)
    && Array.isArray(r.verdicts) && r.verdicts.every((v) => isObj(v) && isStr(v.threadId)
      && (v.verdict === "addressed" || v.verdict === "not_addressed" || v.verdict === "unclear")
      && isStr(v.reason) && isEvidence(v.evidence));
}

function isAiResult(v: unknown, key: PrKey): v is AiResult {
  return isObj(v) && v.version === 1 && v.key === key
    && isStr(v.headSha) && isStr(v.baseSha) && isStr(v.mergeBase) && isStr(v.createdAt)
    && Array.isArray(v.chapters) && v.chapters.every((c) => isObj(c) && isStr(c.title) && isStr(c.summary) && isStrs(c.paths))
    && Array.isArray(v.findings) && v.findings.every(isFinding)
    && isObj(v.handled) && Object.values(v.handled).every((h) => h === "added" || h === "discarded")
    && (v.rereview === undefined || isRereview(v.rereview))
    && (v.roblox === undefined || isRobloxParity(v.roblox))
    && (v.refuted === undefined || (Array.isArray(v.refuted) && v.refuted.every(isRefuted)))
    && isOptStr(v.model) && isOptStr(v.effort);
}

/** The cached result for `prKey`; null when absent or not a valid result. */
export async function loadAiResult(prKey: PrKey): Promise<AiResult | null> {
  const v = await loadReview(aiKey(prKey));
  return isAiResult(v, prKey) ? v : null;
}

export function saveAiResult(r: AiResult): Promise<void> {
  return saveReview(aiKey(r.key), r);
}

/** The PR moved past the head the result analysed. */
export function isStale(result: AiResult, headSha: string): boolean {
  return result.headSha !== headSha;
}
