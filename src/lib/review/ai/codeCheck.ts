import type { FileHunks } from "../types";
import { ROBLOX_PREFIX } from "./roblox";
import type { AiEvidence, AiFinding, TraceStep } from "./types";

/** The two revisions a review reads: the PR's head and its merge-base. */
export type Rev = "head" | "mergeBase";

/** Distinct (rev, path) reads per review; past it, items are left unchecked rather than downgraded. */
export const MAX_FILES = 80;

/** A shorter step quote (non-space chars) proves nothing: `}` or `return;` is everywhere. */
export const MIN_STEP_CHARS = 8;

/** How many lines a step's line may be off by. */
const SLACK = 3;

export const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Whether `quote` (whitespace collapsed, at least `MIN_STEP_CHARS`) is in `text` within `SLACK`
 * lines of `line`; a quote over several lines may run past the window by its own extra lines.
 */
export function stepFound(text: string, line: number, quote: string): boolean {
  const q = collapse(quote);
  if (q.replace(/ /g, "").length < MIN_STEP_CHARS) return false;
  const extra = quote.trim().split("\n").length - 1;
  const lines = text.split(/\r?\n/);
  const from = Math.max(0, line - 1 - SLACK);
  return collapse(lines.slice(from, line + SLACK + extra).join("\n")).includes(q);
}

/** Whether `quote` (whitespace collapsed, non-empty) is anywhere in `text`. */
export function quoteInFile(text: string, quote: string): boolean {
  const q = collapse(quote);
  return q !== "" && collapse(text).includes(q);
}

const key = (rev: Rev, path: string): string => `${rev}|${path}`;
const isRoblox = (path: string): boolean => path.startsWith(ROBLOX_PREFIX);

/** Where an evidence item may be: head, then the merge-base (under its old name if renamed). */
function evidenceKeys(e: AiEvidence, files: FileHunks[]): string[] {
  const old = files.find((f) => f.path === e.path)?.oldPath ?? e.path;
  return [key("head", e.path), key("mergeBase", old)];
}

/** RIGHT at head, LEFT at the merge-base (under its old name if renamed). */
function stepKey(s: TraceStep, files: FileHunks[]): string {
  return s.side === "RIGHT" ? key("head", s.path) : key("mergeBase", files.find((f) => f.path === s.path)?.oldPath ?? s.path);
}

const traceOf = (f: AiFinding): TraceStep[] => f.verification?.trace ?? [];

/** `texts`: by key, the file text, null when it can't be read; a key absent was not read (cap). */
type Texts = Map<string, string | null>;

/** Kept unless every place it may be was read and none has the quote. */
function evidenceHolds(e: AiEvidence, files: FileHunks[], texts: Texts): boolean {
  const ts = evidenceKeys(e, files).map((k) => texts.get(k));
  return ts.some((t) => t === undefined || (t !== null && quoteInFile(t, e.quote)));
}

function stepHolds(s: TraceStep, files: FileHunks[], texts: Texts): boolean {
  if (isRoblox(s.path)) return false; // a step must be repo code
  const t = texts.get(stepKey(s, files));
  return t === undefined || (t !== null && stepFound(t, s.line, s.quote));
}

function check(f: AiFinding, files: FileHunks[], texts: Texts): AiFinding {
  const evidence = f.evidence.filter((e) => isRoblox(e.path) || evidenceHolds(e, files, texts));
  const trace = traceOf(f);
  const failed = trace.findIndex((s) => !stepHolds(s, files, texts));
  const problem = !evidence.length ? "evidence not found in the code"
    : f.status === "confirmed" && !trace.length ? "no failure path"
      : failed >= 0 ? `step ${failed + 1} not found in ${trace[failed].path}:${trace[failed].line}`
        : null;
  if (!problem) return evidence.length === f.evidence.length ? f : { ...f, evidence };
  const v = f.verification ?? { reason: "", trace: [] };
  return { ...f, evidence, status: "unconfirmed", verification: { ...v, problem: v.problem ?? problem } };
}

/**
 * `findings` with their repo evidence and failure paths checked against the code: evidence not
 * found is dropped; a finding left with none, a confirmed one with no trace, or one with a step
 * not found becomes unconfirmed with the first `problem`. `read` rejects for a file absent at
 * `rev`, which counts as not found. Roblox evidence is checked in roblox.ts.
 */
export async function checkFindings(
  findings: AiFinding[], files: FileHunks[], read: (rev: Rev, path: string) => Promise<string>, maxFiles = MAX_FILES,
): Promise<AiFinding[]> {
  const wanted = new Set<string>();
  for (const f of findings) {
    for (const e of f.evidence) if (!isRoblox(e.path)) for (const k of evidenceKeys(e, files)) wanted.add(k);
    for (const s of traceOf(f)) if (!isRoblox(s.path)) wanted.add(stepKey(s, files));
  }
  const texts: Texts = new Map();
  await Promise.all([...wanted].slice(0, maxFiles).map(async (k) => {
    const sep = k.indexOf("|");
    texts.set(k, await read(k.slice(0, sep) as Rev, k.slice(sep + 1)).catch(() => null));
  }));
  return findings.map((f) => check(f, files, texts));
}
